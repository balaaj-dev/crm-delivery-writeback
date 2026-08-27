/**
 * Fully in-memory CrmAdapter. This is what DRY_RUN routes every call
 * through (brief §11) — the whole flow must be demoable with zero real
 * credentials. Seeded with ~20 synthetic contacts so findRecord produces a
 * realistic mix of hits and misses against the fixture events.
 */
import type {
  CanonicalEvent,
  ClientConfig,
  CrmAdapter,
  CrmFieldDescriptor,
  CrmRecordRef,
} from '../types';
import { logger } from '../log';

interface MockContact {
  ref: CrmRecordRef;
  email: string;
  properties: Record<string, string>;
  status?: string;
  activities: Array<{ type: string; occurredAt: string; note: string }>;
  dealCreated?: boolean;
}

const SEED_FIRST_NAMES = [
  'Jordan',
  'Priya',
  'Sam',
  'Casey',
  'Morgan',
  'Alex',
  'Taylor',
  'Riley',
  'Jamie',
  'Drew',
];
const SEED_LAST_NAMES = [
  'Blake',
  'Nair',
  'Ito',
  'Wren',
  'Lee',
  'Chen',
  'Okafor',
  'Rossi',
  'Kim',
  'Novak',
];

function seedContacts(): Map<string, MockContact> {
  const store = new Map<string, MockContact>();
  // Deliberately include jordan.blake@example.com so the shipped fixtures
  // hit a "found" branch, and leave most other fixture emails as misses so
  // the create-record dispatch branches get exercised too.
  const seedEmails = ['jordan.blake@example.com'];
  for (let i = 0; i < 19; i++) {
    const first = SEED_FIRST_NAMES[i % SEED_FIRST_NAMES.length];
    const last = SEED_LAST_NAMES[(i + 3) % SEED_LAST_NAMES.length];
    seedEmails.push(`${first}.${last}.${i}@seed.example.com`.toLowerCase());
  }

  seedEmails.forEach((email, i) => {
    const id = `mock_contact_${i + 1}`;
    store.set(email, {
      ref: { objectType: 'contact', id, url: `https://mock-crm.local/contacts/${id}` },
      email,
      properties: { email },
      activities: [],
    });
  });
  return store;
}

let contacts = seedContacts();
let nextId = contacts.size + 1;

/** Test-only escape hatch so unit tests get a clean seeded store per test. */
export function resetMockAdapterState(): void {
  contacts = seedContacts();
  nextId = contacts.size + 1;
}

function getByEmail(email: string): MockContact | undefined {
  return contacts.get(email.trim().toLowerCase());
}

export const mockAdapter: CrmAdapter = {
  type: 'hubspot', // arbitrary — DRY_RUN callers pass the real cfg.crm.type through separately
  integrationPath: 'native',

  async findRecord(email) {
    const found = getByEmail(email);
    return found ? found.ref : null;
  },

  async createRecord(event: CanonicalEvent, _cfg: ClientConfig) {
    const email = event.prospect.email;
    const existing = getByEmail(email);
    if (existing) return existing.ref;

    const id = `mock_contact_${nextId++}`;
    const ref: CrmRecordRef = {
      objectType: 'contact',
      id,
      url: `https://mock-crm.local/contacts/${id}`,
    };
    contacts.set(email, {
      ref,
      email,
      properties: {
        email,
        firstname: event.prospect.firstName ?? '',
        lastname: event.prospect.lastName ?? '',
        company: event.prospect.company ?? '',
        jobtitle: event.prospect.title ?? '',
        phone: event.prospect.phone ?? '',
      },
      activities: [],
    });
    logger.debug('mock adapter created record', { email, id });
    return ref;
  },

  async writeActivity(ref, event, _cfg) {
    for (const contact of contacts.values()) {
      if (contact.ref.id === ref.id) {
        contact.activities.push({
          type: event.type,
          occurredAt: event.occurredAt,
          note: event.detail.subject ?? event.detail.category ?? event.type,
        });
        return;
      }
    }
    logger.warn('mock adapter writeActivity: ref not found', { ref });
  },

  async updateStatus(ref, status, _cfg) {
    for (const contact of contacts.values()) {
      if (contact.ref.id === ref.id) {
        contact.status = status;
        return;
      }
    }
    logger.warn('mock adapter updateStatus: ref not found', { ref });
  },

  async createDeal(ref, _event, _cfg, _dealSignal) {
    for (const contact of contacts.values()) {
      if (contact.ref.id === ref.id) {
        contact.dealCreated = true;
        return;
      }
    }
  },

  async describeFields(_cfg, objectType): Promise<CrmFieldDescriptor[]> {
    if (objectType !== 'contact') return [];
    return [
      { name: 'email', label: 'Email', type: 'string', required: true },
      { name: 'firstname', label: 'First name', type: 'string', required: false },
      { name: 'lastname', label: 'Last name', type: 'string', required: false },
      { name: 'company', label: 'Company', type: 'string', required: false },
      { name: 'jobtitle', label: 'Job title', type: 'string', required: false },
      { name: 'phone', label: 'Phone', type: 'string', required: false },
    ];
  },

  async testConnection(_cfg) {
    return { ok: true, message: 'Mock adapter always connects successfully.' };
  },
};

/** Exposed for the /log or debug tooling to show what the mock currently holds. */
export function getMockContactByEmail(email: string): MockContact | undefined {
  return getByEmail(email);
}
