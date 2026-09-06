import { deepFreeze, snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { SessionFormatError } from "./error.js";
/** Require a non-negative safe integer. */
export function sessionFormatCount(value, label) {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        throw new SessionFormatError(`${label} must be a non-negative safe integer`);
    }
    return value;
}
/** Read and validate a version without inspecting body rows. */
export function inspectSessionFormatVersion(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new SessionFormatError('Session header must be a JSON object');
    }
    return sessionFormatCount(value.version, 'Session format version');
}
/** Snapshot an arbitrary value at the durable JSON boundary. */
export function snapshotSessionFormatJson(value, label = 'Session value') {
    const snapshot = snapshotJsonValue(value);
    if (snapshot === undefined)
        throw new SessionFormatError(`${label} is not lossless JSON`);
    return deepFreeze(snapshot);
}
/** Snapshot and validate one logical header. */
export function snapshotSessionFormatHeader(value, label = 'Session header') {
    const snapshot = snapshotSessionFormatJson(value, label);
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
        throw new SessionFormatError(`${label} must be a JSON object`);
    }
    const record = snapshot;
    inspectSessionFormatVersion(record);
    if (typeof record.id !== 'string' || record.id.length === 0)
        throw new SessionFormatError(`${label} id must be a non-empty string`);
    sessionFormatCount(record.createdAt, `${label} createdAt`);
    return record;
}
/** Snapshot and validate one complete artifact's coordinates. */
export function snapshotSessionFormatArtifact(value, label = 'Session artifact') {
    const snapshot = snapshotSessionFormatJson(value, label);
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot))
        throw new SessionFormatError(`${label} must be an object`);
    const record = snapshot;
    const header = record.header;
    if (typeof header !== 'object' || header === null || Array.isArray(header))
        throw new SessionFormatError(`${label} header must be an object`);
    snapshotSessionFormatHeader(header, `${label} header`);
    sessionFormatCount(record.inheritedEventCount, `${label} inheritedEventCount`);
    if (!Array.isArray(record.events))
        throw new SessionFormatError(`${label} events must be an array`);
    const events = record.events;
    for (const [index, event] of events.entries()) {
        if (typeof event !== 'object' || event === null || Array.isArray(event))
            throw new SessionFormatError(`${label} event ${index} must be an object`);
        if (event.seq !== index)
            throw new SessionFormatError(`${label} event ${index} has non-dense seq`);
        if (typeof event.type !== 'string' || event.type.length === 0)
            throw new SessionFormatError(`${label} event ${index} type must be non-empty`);
        sessionFormatCount(event.time, `${label} event ${index} time`);
        if (!Object.hasOwn(event, 'data'))
            throw new SessionFormatError(`${label} event ${index} lacks data`);
    }
    if (record.inheritedEventCount > events.length)
        throw new SessionFormatError(`${label} inheritedEventCount exceeds events`);
    return record;
}
//# sourceMappingURL=json.js.map