function validateAdminConfig(env = process.env) {
    if (env.NODE_ENV === 'production' && (typeof env.ADMIN_CODE !== 'string' || env.ADMIN_CODE.trim().length < 16 || env.ADMIN_CODE.length > 256)) {
        throw Error('Production requires ADMIN_CODE with 16-256 characters (excluding surrounding whitespace for the minimum).');
    }
}
module.exports = { validateAdminConfig };
