import { createHmac, timingSafeEqual } from 'crypto';

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

/**
 * Whether header is `sha256=<hex HMAC-SHA256 of rawBody keyed with secret>`, compared in constant
 * time. A missing or malformed header is never valid.
 */
export function isValidSignature(
	rawBody: Buffer,
	header: string | undefined,
	secret: string,
): boolean {
	if (typeof header !== 'string') {
		return false;
	}
	const match = SIGNATURE_PATTERN.exec(header.trim());
	if (match === null) {
		return false;
	}
	const expected = createHmac('sha256', Buffer.from(secret, 'utf8')).update(rawBody).digest();
	const actual = Buffer.from(match[1], 'hex');
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
