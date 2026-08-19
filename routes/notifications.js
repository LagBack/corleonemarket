const router = require('express').Router();
const pool = require('../data/mysql');
const { requireAuth } = require('../middleware/auth');

// GET /api/notifications — List notifications for current user
router.get('', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    // Get notifications with actor details
    const [notifications] = await pool.query(
      `SELECT n.*, u.name as actor_name, u.avatar as actor_avatar
       FROM notifications n
       LEFT JOIN users u ON n.actor_user_id = u.id
       WHERE n.recipient_user_id = ?
       ORDER BY n.created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    // Get total count
    const [countRows] = await pool.query('SELECT COUNT(*) as cnt FROM notifications WHERE recipient_user_id = ?', [userId]);
    const total = countRows[0].cnt;

    res.json({ notifications, total, page, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/notifications/unread-count — Get unread notification count
router.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const [rows] = await pool.query('SELECT COUNT(*) as cnt FROM notifications WHERE recipient_user_id = ? AND is_read = 0', [userId]);
    res.json({ unread_count: rows[0].cnt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/notifications/:id/read — Mark notification as read
router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.session.userId;

    // Check ownership
    const [notifs] = await pool.query('SELECT recipient_user_id FROM notifications WHERE id = ?', [notificationId]);
    if (!notifs.length) return res.status(404).json({ error: 'Notificação não encontrada' });
    if (String(notifs[0].recipient_user_id) !== String(userId)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    // Mark as read
    await pool.query('UPDATE notifications SET `is_read` = 1 WHERE `id` = ?', [notificationId]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/notifications/read-all — Mark all notifications as read
router.post('/read-all', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    await pool.query('UPDATE notifications SET `is_read` = 1 WHERE `recipient_user_id` = ?', [userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/notifications/:id — Delete notification
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.session.userId;

    // Check ownership
    const [notifs] = await pool.query('SELECT recipient_user_id FROM notifications WHERE id = ?', [notificationId]);
    if (!notifs.length) return res.status(404).json({ error: 'Notificação não encontrado' });
    if (String(notifs[0].recipient_user_id) !== String(userId)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    // Delete
    await pool.query('DELETE FROM notifications WHERE id = ?', [notificationId]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/notifications — Delete all notifications
router.delete('', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    await pool.query('DELETE FROM notifications WHERE recipient_user_id = ?', [userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
