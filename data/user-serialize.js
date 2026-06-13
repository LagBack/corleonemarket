const { normalizeRole } = require('./roles');

/** Check if a user row has photo binary data. */
function hasPhotoData(row) {
  if (!row?.photo_data) return false;
  const len = Buffer.isBuffer(row.photo_data)
    ? row.photo_data.length
    : row.photo_data.length;
  return len > 0;
}

/** Return the public photo URL for a user. */
function photoUrlForUser(row) {
  if (!row) return null;
  if (hasPhotoData(row)) return `/api/users/${row.id}/photo`;
  const photo = row.photo && String(row.photo).trim();
  if (photo && photo.startsWith('/uploads/')) return photo;
  return null;
}

/** Return inline data: URI for photo display. */
function photoDataUrl(row) {
  if (!hasPhotoData(row)) return null;
  const mime = row.photo_mime || 'image/jpeg';
  const buf = Buffer.isBuffer(row.photo_data) ? row.photo_data : Buffer.from(row.photo_data);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** Check if the user actually has a photo. */
function hasAnyPhoto(row) {
  if (!row) return false;
  if (hasPhotoData(row)) return true;
  const path = require('path');
  const fs = require('fs');
  const photoPath = path.resolve(__dirname, '..', 'public', String(row.photo).replace(/^\//, ''));
  return fs.existsSync(photoPath);
}

// ── Banner helpers (same pattern as photo) ──

function hasBannerData(row) {
  if (!row?.banner_data) return false;
  const len = Buffer.isBuffer(row.banner_data)
    ? row.banner_data.length
    : row.banner_data.length;
  return len > 0;
}

function bannerUrlForUser(row) {
  if (!row) return null;
  if (hasBannerData(row)) return `/api/users/${row.id}/banner`;
  const b = row.banner && String(row.banner).trim();
  if (b && b.startsWith('/uploads/')) return b;
  return null;
}

function bannerDataUrl(row) {
  if (!hasBannerData(row)) return null;
  const mime = row.banner_mime || 'image/jpeg';
  const buf = Buffer.isBuffer(row.banner_data) ? row.banner_data : Buffer.from(row.banner_data);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function hasAnyBanner(row) {
  if (!row) return false;
  if (hasBannerData(row)) return true;
  const path = require('path');
  const fs = require('fs');
  const bPath = path.resolve(__dirname, '..', 'public', String(row.banner).replace(/^\//, ''));
  return fs.existsSync(bPath);
}

/** Strip secrets/binary fields; expose stable photo + banner URLs for the client. */
function toPublicUser(row, opts = {}) {
  if (!row) return null;
  const { pass, photo_data, photo_mime, banner_data, banner_mime, ...rest } = row;
  if (rest.role != null) rest.role = normalizeRole(rest.role);
  if (rest.has_donated != null) { rest.hasDonated = !!rest.has_donated; delete rest.has_donated; }
  rest.photo = hasAnyPhoto(row) ? photoUrlForUser(row) : null;
  rest.banner = hasAnyBanner(row) ? bannerUrlForUser(row) : null;
  if (opts.includePhotoData) {
    rest.photoDisplay = photoDataUrl(row);
    rest.bannerDisplay = bannerDataUrl(row);
  }
  return rest;
}

module.exports = {
  photoUrlForUser, photoDataUrl, toPublicUser, hasAnyPhoto, hasPhotoData,
  hasBannerData, bannerUrlForUser, bannerDataUrl, hasAnyBanner,
};
