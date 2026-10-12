/**
 * Kenyan phone number formatting and validation.
 * Everything is normalised to the 254XXXXXXXXX format Daraja expects.
 */

const ERRORS = {
  REQUIRED: 'Phone number is required.',
  CHARACTERS: 'Phone number must contain only digits, spaces, dashes, or a leading +.',
  TOO_SHORT: 'Phone number too short. Must be 10 digits (07XX) or 12 digits (254XX).',
  LENGTH: 'Invalid phone number length. Must be 10 digits (07XX) or 12 digits (254XX).',
  INVALID: 'Invalid Kenyan phone number. Must start with 07, 01, or 254.',
};

/**
 * @param {string|number} phone
 * @returns {{success: true, formatted: string} | {success: false, error: string}}
 */
function formatPhoneNumber(phone) {
  if (phone === undefined || phone === null) {
    return { success: false, error: ERRORS.REQUIRED };
  }
  // Numbers are tolerated (JSON clients sometimes send 254712345678 unquoted).
  if (typeof phone === 'number') phone = String(phone);
  if (typeof phone !== 'string') {
    return { success: false, error: ERRORS.CHARACTERS };
  }

  const trimmed = phone.trim();
  if (trimmed === '') {
    return { success: false, error: ERRORS.REQUIRED };
  }

  // Only digits, spaces, dashes, and one optional leading "+".
  if (!/^\+?[\d\s-]+$/.test(trimmed)) {
    return { success: false, error: ERRORS.CHARACTERS };
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) {
    return { success: false, error: ERRORS.CHARACTERS };
  }
  if (digits.length < 10) {
    return { success: false, error: ERRORS.TOO_SHORT };
  }

  if (digits.startsWith('254')) {
    if (digits.length !== 12) return { success: false, error: ERRORS.LENGTH };
    if (!/^254[17]/.test(digits)) return { success: false, error: ERRORS.INVALID };
    return { success: true, formatted: digits };
  }

  if (digits.startsWith('0')) {
    if (!/^0[17]/.test(digits)) return { success: false, error: ERRORS.INVALID };
    if (digits.length !== 10) return { success: false, error: ERRORS.LENGTH };
    return { success: true, formatted: `254${digits.slice(1)}` };
  }

  return { success: false, error: ERRORS.INVALID };
}

function isValidKenyanPhone(phone) {
  return formatPhoneNumber(phone).success === true;
}

/**
 * Masks a phone number for logs: 254712345678 -> 2547****5678.
 * Works on any input, including invalid ones, and never throws.
 */
function maskPhone(phone) {
  const digits = String(phone === undefined || phone === null ? '' : phone).replace(/\D/g, '');
  if (digits.length < 8) return '****';
  return `${digits.slice(0, 4)}****${digits.slice(-4)}`;
}

module.exports = { formatPhoneNumber, isValidKenyanPhone, maskPhone, ERRORS };
