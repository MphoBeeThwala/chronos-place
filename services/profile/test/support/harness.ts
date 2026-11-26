import { createLogger } from '@chronos/logger';
import { ProfileService } from '../../src/profiles/profile.service.js';
import { FakeBlocks, FakeMemberFacts, InMemoryProfileStore } from './profile-fakes.js';

export const ACCOUNT = '55555555-5555-4555-8555-555555555555';

export function setup(destination: { write: (l: string) => void } = { write: () => undefined }) {
  const store = new InMemoryProfileStore();
  const facts = new FakeMemberFacts();
  const blocks = new FakeBlocks();
  const service = new ProfileService({
    profiles: store,
    facts,
    visibility: blocks,
    logger: createLogger({ service: 'profile-test', level: 'trace', destination }),
  });
  return { store, service, facts, blocks };
}
