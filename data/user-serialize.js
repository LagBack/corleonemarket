const { normalizeRole } = require('./roles');

/** Strip secrets/binary fields; expose a stable photo URL for the client. */
function hasPhotoData(row) {
  if (!row?.photo_data) return false;
  const len = Buffer.isBuffer(row.photo_data)
    ? row.photo_data.length
    : row.photo_data.length;
  return len > 0;
}

function photoUrlForUser(row) {
  if (!row) return null;
  // Prefer db-stored data (always valid when returned)
  if (hasPhotoData(row)) {
    return `/api/users/${row.id}/photo`;
  }
  // Only return legacy disk path if we can't guarantee the file exists on disk
  // The caller should verify existence before using it
  if (row.photo && String(row.photo).startsWith('/uploads/')) {
    return row.photo;
  }
  return row.photo || null;
}

function photoDataUrl(row) {
  if (!hasPhotoData(row)) return null;
  const mime = row.photo_mime || 'image/jpeg';
  const buf = Buffer.isBuffer(row.photo_data) ? row.photo_data : Buffer.from(row.photo_data);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function hasAnyPhoto(row) {
  /** Check if the user actually has a photo (db blob or legacy disk file). */
  if (!row) return false;
  if (hasPhotoData(row)) return true;
  // Legacy: only consider it valid if the disk path looks correct and exists
  const path = require('path');
  const fs = require('fs');
  const photoPath = path.resolve(__dirname, '..', 'public', String(row.photo).replace(/^\//, ''));
  return fs.existsSync(photoPath);
}

function toPublicUser(row, opts = {}) {
  if (!row) return null;
  const { pass, photo_data, photo_mime, ...rest } = row;
  if (rest.role != null) rest.role = normalizeRole(rest.role);
  // Only set photo field if there's actual backing data; otherwise null so client falls back to emoji
  rest.photo = hasAnyPhoto(row) ? photoUrlForUser(row) : null;
  if (opts.includePhotoData) {
    rest.photoDisplay = photoDataUrl(row);
  }
  return rest;
}

module.exports = { photoUrlForUser, photoDataUrl, toPublicUser, hasPhotoData };
