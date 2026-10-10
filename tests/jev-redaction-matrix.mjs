// Jev credential fixtures exercise the shared preflight/sanitizer through
// CLI errors and the plugin RPC's key-label/error-message paths. The adapters
// preserve their own error classes and caps; the patterns have one owner.
//
// Every fixture is assembled from tests/fake-secrets.mjs fragments — no
// detector-matching literal exists in this file either.
//
// Case shape:
//   { name, text, detect: { pattern, secrets } }  — must redact identically
//       on both sides: assertRedacted throws `(${pattern})`; both
//       sanitizeRemoteText surfaces emit '<redacted>' and never leak any
//       of `secrets` (every substring listed).
//   { name, text, detect: null }                  — must pass through:
//       assertRedacted stays silent; sanitizeRemoteText returns `text`
//       byte-identical.
import {
  fakeOrKey, fakeTsKey, fakeAwsKey, fakePem, fakeOpenAiKey,
  fakeBearer, fakeGhToken, fakeSlackToken, fakeGoogleKey, fakeJwt,
} from './fake-secrets.mjs';

const redact = (name, text, pattern, secrets = [text]) => ({ name, text, detect: { pattern, secrets } });
const pass = (name, text) => ({ name, text, detect: null });

export const redactionFixtures = [
  // -- one satisfying shape per detector class ------------------------------
  redact('openrouter key', fakeOrKey('abcdef0123456789'), 'openrouter-key'),
  redact('typesafe key', fakeTsKey('abcdef0123456789'), 'typesafe-key'),
  redact('openai-style key', fakeOpenAiKey('abcdefghij0123456789'), 'openai-style-key'),
  redact('bearer token', fakeBearer('abcdefghij0123456789'), 'bearer-token'),
  redact('private-key block (OPENSSH)', fakePem('OPENSSH'), 'private-key-block'),
  redact('private-key block (RSA)', fakePem('RSA'), 'private-key-block'),
  redact('aws access key', fakeAwsKey(), 'aws-access-key'),
  redact('github token', fakeGhToken('abcdefghijklmnopqrst'), 'github-token'),
  redact('slack token', fakeSlackToken('abcdefghij12'), 'slack-token'),
  redact('google api key', fakeGoogleKey('a'.repeat(35)), 'google-api-key'),
  redact('jwt', fakeJwt(), 'jwt'),

  // -- matching-context variants --------------------------------------------
  // The bearer pattern is /i: lowercase and uppercase forms redact.
  redact('lowercase bearer', fakeBearer('abcdefghij0123456789').toLowerCase(), 'bearer-token'),
  redact('uppercase bearer', fakeBearer('abcdefghij0123456789').toUpperCase(), 'bearer-token'),
  // A credential mid-string (a '=' / space boundary is enough) still redacts.
  redact('embedded openrouter key', `key=${fakeOrKey('embed0123456789')} tail`, 'openrouter-key', [fakeOrKey('embed0123456789')]),
  // One string holding two classes: sanitize scrubs BOTH; assertRedacted
  // names the first matching pattern in declaration order (openrouter-key
  // precedes typesafe-key) regardless of position in the text.
  redact(
    'two classes in one string',
    `${fakeTsKey('firstkey1234567')} then ${fakeOrKey('secondkey123456')}`,
    'openrouter-key',
    [fakeTsKey('firstkey1234567'), fakeOrKey('secondkey123456')],
  ),
  // An sk-or- key with a ≥20-char tail satisfies openai-style-key too —
  // declaration order, not specificity, picks the reported class.
  redact('sk-or key also matching sk- shape', fakeOrKey('abcdef0123456789abcdef'), 'openrouter-key'),
  // Open-ended classes ({N,} with no trailing \b) still redact over-length.
  redact('over-length openrouter key', fakeOrKey('a'.repeat(100)), 'openrouter-key'),
  redact('over-length github token', fakeGhToken('a'.repeat(30)), 'github-token'),

  // -- boundary pass-throughs: one char short of each class -----------------
  pass('short openrouter key', fakeOrKey('x')),
  pass('short typesafe key', fakeTsKey('short')),
  pass('short openai-style key', fakeOpenAiKey('abc')),
  pass('short bearer token', fakeBearer('abc')),
  pass('short github token', fakeGhToken('abc')),
  pass('short slack token', fakeSlackToken('abc')),
  pass('short google api key', fakeGoogleKey('a'.repeat(34))),
  // Exactly-bounded classes ({N}\b): over-length fails the trailing word
  // boundary, so a longer token is NOT redacted — pinned asymmetry vs the
  // open-ended classes above.
  pass('over-length google api key', fakeGoogleKey('a'.repeat(36))),
  pass('over-length aws access key', fakeAwsKey() + 'Z'),
  // No word boundary before the marker → glued text is not a credential.
  pass('glued aws access key', 'x' + fakeAwsKey()),
  pass('glued openai-style key', 'x' + fakeOpenAiKey('abcdefghij0123456789')),
  // private-key-block is case-sensitive (unlike /i bearer): a lowercase PEM
  // header and a PUBLIC block both pass.
  pass('lowercase pem header', fakePem('OPENSSH').toLowerCase()),
  pass('public key block', ['-----BEGIN', 'PUBLIC', 'KEY-----'].join(' ')),
  // A two-segment eyJ token lacks the third segment the jwt class requires.
  pass('two-segment jwt', ['eyJ' + 'a'.repeat(12), 'b'.repeat(12)].join('.')),
  // The detector set is credential-SHAPED, not generic-secret: ordinary
  // password/secret-looking prose passes through untouched.
  pass('generic secret prose', 'the rotated password is hunter2'),
  pass('redaction marker itself', '<redacted>'),
  pass('ordinary brief', 'an ordinary routing brief'),
];
