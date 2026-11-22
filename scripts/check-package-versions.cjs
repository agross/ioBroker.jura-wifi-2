const assert = require('node:assert/strict');
const { version } = require('../package.json');
const lockfile = require('../package-lock.json');
const { common } = require('../io-package.json');

assert.equal(
  common.version,
  version,
  'io-package.json version must match package.json',
);
assert.equal(
  lockfile.version,
  version,
  'package-lock.json version must match package.json',
);
assert.equal(
  lockfile.packages[''].version,
  version,
  'Lockfile root package version must match package.json',
);

if (process.env.RELEASE_TAG) {
  assert.equal(
    process.env.RELEASE_TAG,
    `v${version}`,
    'Release tag must match package.json version',
  );
}
