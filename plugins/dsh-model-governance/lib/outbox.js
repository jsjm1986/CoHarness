import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Crash-safe local outbox; each record is committed by same-directory rename. */
export class UsageOutbox {
    dir;
    url;
    token;
    pumping = Promise.resolve();
    timer;
    closed = false;
    constructor(dir, url, token) {
        this.dir = dir;
        this.url = url;
        this.token = token;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.timer = setInterval(() => this.kick(), 5_000);
        this.timer.unref();
        this.kick();
    }
    /**
     * Replace the intake destination used by future delivery attempts.
     * @param url - loopback intake URL from the validated policy.
     * @param token - bearer token from the validated policy.
     */
    setEndpoint(url, token) {
        if (this.closed)
            return;
        this.url = url;
        this.token = token;
    }
    enqueue(record) {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const target = join(this.dir, `${record.eventId}.json`);
        const temp = `${target}.${randomBytes(5).toString('hex')}.tmp`;
        const fd = openSync(temp, 'wx', 0o600);
        try {
            writeFileSync(fd, JSON.stringify(record));
            closeSync(fd);
            renameSync(temp, target);
        }
        catch (error) {
            try {
                closeSync(fd);
            }
            catch { /* already closed */ }
            rmSync(temp, { force: true });
            throw error;
        }
        this.kick();
    }
    kick() {
        if (this.closed)
            return;
        this.pumping = this.pumping.then(() => this.drain(), () => this.drain());
    }
    async drain() {
        for (const name of readdirSync(this.dir).filter(name => name.endsWith('.json')).sort()) {
            if (this.closed)
                return;
            const path = join(this.dir, name);
            let body;
            try {
                body = await import('node:fs/promises').then(fs => fs.readFile(path, 'utf8'));
            }
            catch {
                return;
            }
            const post = (payload) => fetch(this.url, {
                method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
                body: payload, signal: AbortSignal.timeout(5_000),
            });
            let response;
            try {
                response = await post(body);
            }
            catch {
                return;
            }
            if (!response.ok && response.status === 400) {
                const fallback = actorlessUsageBody(body);
                if (fallback !== undefined) {
                    try {
                        response = await post(fallback);
                    }
                    catch {
                        return;
                    }
                }
            }
            if (!response.ok)
                return;
            rmSync(path, { force: true });
        }
    }
    async close() {
        this.closed = true;
        clearInterval(this.timer);
        await this.pumping;
    }
}
/** Remove unverifiable activity fields while preserving the billable usage event. */
function actorlessUsageBody(body) {
    let value;
    try {
        value = JSON.parse(body);
    }
    catch {
        return undefined;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const record = value;
    if (record.kind === 'model-registration'
        || (!Object.hasOwn(record, 'actorUserId') && !Object.hasOwn(record, 'actorProjectId')))
        return undefined;
    delete record.actorUserId;
    delete record.actorProjectId;
    return JSON.stringify(record);
}
