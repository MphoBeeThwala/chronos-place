/**
 * Who is calling, from the client certificate verified by mTLS (ADR-0004, M2.5). Each service's
 * certificate carries exactly one URI SAN `spiffe://<trust domain>/<service>`, issued by our own CA.
 * Nothing the caller sends (metadata, request fields) is ever used as its identity.
 */
export const DEFAULT_TRUST_DOMAIN = 'chronos-place.internal';
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** `spiffe://<trust domain>/<service>` for a service name. */
export const spiffeId = (service: string, trustDomain = DEFAULT_TRUST_DOMAIN): string =>
  `spiffe://${trustDomain}/${service}`;

/**
 * The service named by a certificate's `subjectaltname` (Node's `URI:…, DNS:…` form), or undefined
 * unless exactly one URI SAN is in the trust domain and names a valid service.
 */
export function serviceFromSubjectAltName(
  subjectAltName: string | undefined,
  trustDomain = DEFAULT_TRUST_DOMAIN,
): string | undefined {
  if (subjectAltName === undefined) return undefined;
  const prefix = `URI:spiffe://${trustDomain}/`;
  const ours = subjectAltName
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('URI:spiffe://'));
  if (ours.length !== 1 || ours[0]?.startsWith(prefix) !== true) return undefined;
  const name = ours[0].slice(prefix.length);
  return SERVICE_NAME.test(name) ? name : undefined;
}

interface CallWithAuth {
  getAuthContext?: () => { sslPeerCertificate?: { subjectaltname?: string } };
}

/** The calling service of a gRPC server call, or undefined without a verified client certificate. */
export function callerOf(call: unknown, trustDomain = DEFAULT_TRUST_DOMAIN): string | undefined {
  const auth = (call as CallWithAuth | undefined)?.getAuthContext?.();
  return serviceFromSubjectAltName(auth?.sslPeerCertificate?.subjectaltname, trustDomain);
}
