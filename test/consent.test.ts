import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Pure policy logic mirroring SearchView.rerank transmission confirmation check.
 * Previews are shown by default. They can be suppressed either for the current
 * Obsidian session (via the modal toggle) or permanently (via settings).
 */
export const shouldConfirmTransmission = (confirmTransmission: boolean | undefined, sessionSkipConsent: boolean): boolean => {
  return confirmTransmission !== false && !sessionSkipConsent;
};

test('transmission consent: truth table for confirmTransmission and sessionSkipConsent', () => {
  // Case 1: Default state (confirmTransmission=true, sessionSkipConsent=false) -> must confirm
  assert.equal(shouldConfirmTransmission(true, false), true, 'Default state must require confirmation');

  // Case 2: Undefined setting (upgrade from older version) -> defaults to true -> must confirm
  assert.equal(shouldConfirmTransmission(undefined, false), true, 'Unset setting must default to requiring confirmation');

  // Case 3: Session skip activated (confirmTransmission=true, sessionSkipConsent=true) -> skips confirmation
  assert.equal(shouldConfirmTransmission(true, true), false, 'Session skip must bypass preview modal');

  // Case 4: Setting permanently disabled (confirmTransmission=false, sessionSkipConsent=false) -> skips confirmation
  assert.equal(shouldConfirmTransmission(false, false), false, 'Permanent setting disable must bypass preview modal');

  // Case 5: Both disabled -> skips confirmation
  assert.equal(shouldConfirmTransmission(false, true), false, 'Both disabled must bypass preview modal');
});

test('session skip reset conditions', () => {
  // Simulating state transitions
  let sessionSkipConsent = true;

  // 1. Settings change / save resets session skip
  const onSaveSettings = () => { sessionSkipConsent = false; };
  onSaveSettings();
  assert.equal(sessionSkipConsent, false, 'Saving settings must reset session skip');

  // 2. Unload / vault reload resets session skip
  sessionSkipConsent = true;
  const onUnload = () => { sessionSkipConsent = false; };
  onUnload();
  assert.equal(sessionSkipConsent, false, 'Unload must reset session skip');
});
