const proxyaddr = require('proxy-addr');
const { isIP } = require('node:net');

function configureClientIp(app, env = process.env) {
    const setting = (env.TRUST_PROXY || 'false').trim();
    let trust;
    // Never accept blanket trust. Hop counts require a verified, fixed proxy path;
    // prefer explicit proxy CIDRs when the deployment provides stable ranges.
    if (setting === 'false' || setting === '0') trust = false;
    else if (/^[1-5]$/.test(setting)) trust = Number(setting);
    else {
        if (setting === 'true') throw Error('TRUST_PROXY must be false, a verified hop count (1-5), or trusted proxy CIDRs.');
        try { trust = proxyaddr.compile(setting.split(',').map(value => value.trim())); }
        catch { throw Error('TRUST_PROXY contains an invalid proxy address configuration.'); }
    }
    app.set('trust proxy', trust);
    const trusted = app.get('trust proxy fn');
    return req => {
        const remote = req.socket?.remoteAddress || req.connection?.remoteAddress;
        let address;
        try { address = proxyaddr(req, trusted); } catch { address = remote; }
        if (!isIP(address)) address = remote;
        if (!isIP(address)) return 'unknown';
        // One key for IPv4 and its IPv4-mapped IPv6 representation.
        if (/^::ffff:(\d+\.){3}\d+$/i.test(address)) return address.slice(7);
        return isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
    };
}
module.exports = { configureClientIp };
