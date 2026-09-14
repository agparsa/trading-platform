/**
 * Every column in this platform that holds a sealed value, declared once.
 *
 * ## Why this file exists
 *
 * `encryption-at-rest.md` documented a key rotation in five steps, and step 4
 * was "re-seal the stored rows under key 2". Nothing in the repository could do
 * that. There was no rotation job, no script, and no way to answer the question
 * step 5 depends on — *is any row still sealed under the old key?* — short of
 * opening every row by hand.
 *
 * That is worse than a missing feature. The documented procedure ends with
 * "**only then** may key 1 be dropped", and an operator who works through it,
 * finds nothing to run at step 4, and assumes a restart did the re-sealing,
 * drops a key that is still holding every enrolled second factor, every
 * identity document, every venue credential and every withdrawal destination in
 * the system. Those values are then unreadable, permanently, and the failure
 * surfaces one user at a time over the following weeks.
 *
 * ## Why a registry, rather than a rotation function per module
 *
 * The obstacle to writing that job was never the cryptography. It was that a
 * sealed value cannot be re-sealed without the **context** it was bound to as
 * additional authenticated data, and each context was a private helper next to
 * the code that sealed it: `contextFor` in the TOTP service, `sealContext` in
 * devices, a bare row id in webhooks. A rotation job would have had to
 * re-derive seven of those from memory, and the cost of getting one wrong is
 * a column of values that no longer open.
 *
 * So the context builders live here, the call sites import them, and this list
 * is the single answer to "what is sealed in this system". `sealed-columns.test`
 * checks it against two things it does not control: the Prisma schema, so a
 * declared column must exist, and every `seal`/`sealBytes` call site in the
 * apps, so a new sealed column cannot be added without being declared here.
 */

/** How a value is stored: a self-describing string, or framed bytes. */
export type SealedForm = 'text' | 'bytes';

export interface SealedColumn {
  /** The Prisma model delegate, e.g. `kycDocument`. */
  readonly model: string;
  /** The Prisma field holding the sealed value. */
  readonly field: string;
  readonly form: SealedForm;
  /** True when the column may be null — a row with nothing sealed in it yet. */
  readonly nullable: boolean;
  /** The fields a row must carry for `context` to be computable. */
  readonly needs: readonly string[];
  /** The AAD the value was sealed under. */
  readonly context: (row: Record<string, unknown>) => string;
  /**
   * The column carrying the key id in the clear, where one exists.
   *
   * Only the byte columns have one: their frame carries the key id too, but a
   * ten-megabyte document should not have to be read out of the database to
   * answer "which key wrote this". The text form carries its key id in the
   * value itself, which is cheap enough to read.
   */
  readonly keyIdField?: string;
  /** One line for the rotation report, so an operator knows what moved. */
  readonly describes: string;
}

const str = (row: Record<string, unknown>, field: string): string => {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`a sealed row is missing ${field}, which its context is built from`);
  }
  return value;
};

/** The AAD a TOTP secret is sealed under. Changing it invalidates every enrolment. */
export function totpSealContext(userId: string): string {
  return `user:${userId}:totp`;
}

/** The AAD an identity document is sealed under: its own row and nothing else. */
export function documentSealContext(documentId: string): string {
  return `kyc:document:${documentId}`;
}

/** The AAD a built report is sealed under. The API and the worker share it. */
export function reportSealContext(reportId: string): string {
  return `report:${reportId}`;
}

/** The AAD a withdrawal destination is sealed under: its own request. */
export function destinationSealContext(requestId: string): string {
  return `withdrawal:destination:${requestId}`;
}

/**
 * The AAD a push token is sealed under.
 *
 * Both parts matter: a token lifted from one row into another fails to open
 * rather than decrypting into a token that would deliver somebody else's
 * balance to the wrong phone.
 */
export function deviceSealContext(userId: string, installationId: string): string {
  return `device:${userId}:${installationId}`;
}

/**
 * Webhook secrets and venue credentials are bound to a bare id.
 *
 * They predate the prefixed contexts above and are named here rather than
 * changed: the prefix buys nothing a unique id does not already give, and
 * changing an AAD is not a refactor — it is a column of values that stop
 * opening.
 */
export function idSealContext(id: string): string {
  return id;
}

export const SEALED_COLUMNS: readonly SealedColumn[] = [
  {
    model: 'user',
    field: 'totpSecret',
    form: 'text',
    nullable: true,
    needs: ['id'],
    context: (row) => totpSealContext(str(row, 'id')),
    describes: 'the shared secret behind a second factor',
  },
  {
    model: 'kycDocument',
    field: 'content',
    form: 'bytes',
    nullable: true,
    needs: ['id'],
    context: (row) => documentSealContext(str(row, 'id')),
    keyIdField: 'sealedWithKeyId',
    describes: 'a scan of somebody’s identity document',
  },
  {
    model: 'report',
    field: 'content',
    form: 'bytes',
    nullable: true,
    needs: ['id'],
    context: (row) => reportSealContext(str(row, 'id')),
    keyIdField: 'sealedWithKeyId',
    describes: 'a built export, until its retention runs out',
  },
  {
    model: 'webhookEndpoint',
    field: 'secretSealed',
    form: 'text',
    nullable: false,
    needs: ['id'],
    context: (row) => idSealContext(str(row, 'id')),
    describes: 'the secret an endpoint signs with',
  },
  {
    model: 'webhookEndpoint',
    field: 'previousSecretSealed',
    form: 'text',
    nullable: true,
    needs: ['id'],
    context: (row) => idSealContext(str(row, 'id')),
    describes: 'the secret being retired, during an overlap',
  },
  {
    model: 'brokerCredential',
    field: 'sealed',
    form: 'text',
    nullable: false,
    needs: ['connectionId'],
    context: (row) => idSealContext(str(row, 'connectionId')),
    describes: 'what this platform signs in to a venue with',
  },
  {
    model: 'device',
    field: 'pushToken',
    form: 'text',
    nullable: true,
    needs: ['userId', 'installationId'],
    context: (row) => deviceSealContext(str(row, 'userId'), str(row, 'installationId')),
    describes: 'where a trader’s notifications are delivered',
  },
  {
    model: 'withdrawalRequest',
    field: 'destination',
    form: 'text',
    nullable: false,
    needs: ['id'],
    context: (row) => destinationSealContext(str(row, 'id')),
    describes: 'the bank account money leaves to',
  },
];

/** Every model with a sealed column, once each. */
export const SEALED_MODELS: readonly string[] = [
  ...new Set(SEALED_COLUMNS.map((column) => column.model)),
];
