const helmet = require('helmet');

function securityHeaders(env = process.env) {
    const production = env.NODE_ENV === 'production';
    return helmet({
        strictTransportSecurity: production ? { maxAge: 31536000, includeSubDomains: false } : false,
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                scriptSrcAttr: ["'none'"],
                styleSrc: ["'self'"],
                styleSrcAttr: ["'none'"],
                fontSrc: ["'self'"],
                // The developer page previews selected files with object URLs.
                imgSrc: ["'self'", 'blob:'],
                connectSrc: ["'self'", req => {
                    // Explicit same-host WebSocket source for browsers where 'self'
                    // does not cover ws/wss. Never trust forwarded Host headers.
                    try { return new URL(`${production ? 'wss' : 'ws'}://${req.headers.host}`).origin; }
                    catch { return "'self'"; }
                }],
                objectSrc: ["'none'"],
                baseUri: ["'none'"],
                frameAncestors: ["'none'"],
                formAction: ["'self'"],
                upgradeInsecureRequests: production ? [] : null
            }
        }
    });
}
module.exports = { securityHeaders };
