const { clientError } = require('./client-errors');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 512 * 1024;
const IMAGE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IMAGE_PATH = /^\/category-images\/([a-f0-9-]+)\.webp$/;
const DEFAULT_IMAGES = new Set(['/images/categories/islamic.webp', '/images/categories/placeholder.svg']);

function createCategoryImageStore({ filename, env, getPool, canWrite }) {
    const directory = path.join(path.dirname(filename), 'category-images');
    let ready = false;
    let storage = 'رفع الصور غير متاح حتى يصبح حفظ الأسئلة جاهزًا.';
    return {
        async init() {
            if (!canWrite()) return;
            if (env.DATABASE_URL) {
                try {
                    await getPool().query('SELECT id FROM public.wamda_category_images LIMIT 0');
                    ready = true;
                    storage = 'صور محفوظة في PostgreSQL';
                } catch {
                    storage = 'لرفع الصور نفّذ migrations/002_wamda_category_images.sql في Supabase ثم أعد تشغيل الخادم.';
                }
            } else {
                ready = true;
                storage = 'صور محفوظة بجانب ملف بنك الأسئلة';
            }
        },
        status() { return { imagesWritable: ready && canWrite(), imageStorage: storage }; },
        async upload({ data, type } = {}) {
            if (!ready || !canWrite()) throw clientError(storage);
            if (!Buffer.isBuffer(data) || !data.length || data.length > MAX_UPLOAD_BYTES) throw clientError('اختر صورة بحجم لا يتجاوز 2 ميجابايت.');
            const formats = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
            if (!Object.hasOwn(formats, type || '')) throw clientError('استخدم صورة PNG أو JPEG أو WebP.');
            let output;
            try {
                const image = sharp(data, { limitInputPixels: 4_000_000, failOn: 'warning', animated: true });
                const metadata = await image.metadata();
                if (metadata.format !== formats[type] || (metadata.pages || 1) !== 1) throw clientError('invalid image');
                // Decode/re-encode strips metadata and prevents serving executable or malformed uploads.
                output = await image.rotate().resize({ width: 960, height: 720, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
                if (output.length > MAX_IMAGE_BYTES) throw clientError('image too large');
            } catch { throw clientError('الصورة غير صالحة أو كبيرة جدًا. اختر صورة ثابتة لا تتجاوز 4 ملايين بكسل.'); }
            const id = randomUUID();
            try {
                if (env.DATABASE_URL) await getPool().query('INSERT INTO public.wamda_category_images (id, data) VALUES ($1, $2)', [id, output]);
                else {
                    await fs.mkdir(directory, { recursive: true });
                    await fs.writeFile(path.join(directory, `${id}.webp`), output, { mode: 0o600, flag: 'wx' });
                }
            } catch { throw clientError('تعذر حفظ الصورة. حاول مرة أخرى.'); }
            return { image: `/category-images/${id}.webp` };
        },
        async read(id) {
            if (!IMAGE_ID.test(id)) return null;
            if (env.DATABASE_URL) {
                if (!ready) return null;
                const result = await getPool().query('SELECT data FROM public.wamda_category_images WHERE id = $1', [id]);
                return result.rows[0] ? Buffer.from(result.rows[0].data) : null;
            }
            try { return await fs.readFile(path.join(directory, `${id}.webp`)); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        },
        async validate(image) {
            if (typeof image !== 'string' || image.length > 200) throw clientError('اختر صورة صالحة للتصنيف.');
            if (DEFAULT_IMAGES.has(image)) return image;
            const match = image.match(IMAGE_PATH);
            if (!match) throw clientError('ارفع صورة التصنيف أولًا.');
            let found;
            try { found = await this.read(match[1]); }
            catch { throw clientError('تعذر التحقق من صورة التصنيف. حاول مرة أخرى.'); }
            if (!found) throw clientError('ارفع صورة التصنيف أولًا.');
            return image;
        }
    };
}

function installCategoryImages(app, store) {
    app.get('/category-images/:filename', async (req, res) => {
        const match = req.params.filename.match(/^([a-f0-9-]+)\.webp$/);
        if (!match || !IMAGE_ID.test(match[1])) return res.sendStatus(404);
        try {
            const data = await store.readCategoryImage(match[1]);
            if (!data) return res.sendStatus(404);
            res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }).send(data);
        } catch { res.sendStatus(503); }
    });
}
module.exports = { createCategoryImageStore, installCategoryImages, MAX_UPLOAD_BYTES };
