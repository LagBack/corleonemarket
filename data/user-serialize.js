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
  if (hasPhotoData(row)) {
    return `/api/users/${row.id}/photo`;
  }
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

function toPublicUser(row, opts = {}) {
  if (!row) return null;
  const { pass, photo_data, photo_mime, ...rest } = row;
  rest.photo = photoUrlForUser(row);
  if (opts.includePhotoData) {
    rest.photoDisplay = photoDataUrl(row);
  }
  return rest;
}

module.exports = { photoUrlForUser, photoDataUrl, toPublicUser, hasPhotoData };
