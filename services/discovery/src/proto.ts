import { fileURLToPath } from 'node:url';

const proto = (name: string) =>
  fileURLToPath(import.meta.resolve(`@chronos/contracts/proto/chronos/${name}/v1/${name}.proto`));

export const DISCOVERY_PROTO = proto('discovery');
export const DISCOVERY_PACKAGE = 'chronos.discovery.v1';
export const PROFILE_PROTO = proto('profile');
export const MATCHING_PROTO = proto('matching');
export const DISCLOSURE_PROTO = proto('disclosure');
