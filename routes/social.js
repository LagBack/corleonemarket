const router = require('express').Router();
const pool = require('../data/mysql');
const { requireAuth, requireAdmin, requireMod } = require('../middleware/auth');

// Helper: Get user details for posts/comments
async function getUserDetails(userId) {
  if (!userId) return null;
  const [rows] = await pool.query('SELECT id, name, nick, avatar, photo, role FROM users WHERE id = ?', [userId]);
  return rows.length ? rows[0] : null;
}

// Helper: Sanitize content (basic XSS prevention)
function sanitizeContent(text) {
  if (!text) return '';
  return String(text)
    .replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;')
    .trim();
}

const SOCIAL_POST_CHAR_LIMIT = 900;
const SOCIAL_COMMENT_CHAR_LIMIT = 300;
const SOCIAL_TITLE_CHAR_LIMIT = 200;
const SOCIAL_BAD_WORDS = [
  'merda','porra','caralho','foda','puta','piranha','buceta','viado','otario','otário','arrombado','burra','burro','idiota','estupido','estúpido','babaca','filhoda','filho da puta','puta que pariu','desgraça','vaca'
];

function normalizeText(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function containsBadWords(text) {
  const normalized = normalizeText(text);
  return SOCIAL_BAD_WORDS.some(word => {
    const safeWord = normalizeText(word);
    return new RegExp(`\\b${safeWord}\\b`, 'i').test(normalized);
  });
}

function validateSocialContent(title, content) {
  if (!title || !title.trim()) return 'Título é obrigatório';
  if (!content || !content.trim()) return 'Conteúdo é obrigatório';
  if (title.trim().length > SOCIAL_TITLE_CHAR_LIMIT) return `Título deve ter até ${SOCIAL_TITLE_CHAR_LIMIT} caracteres`;
  if (content.trim().length > SOCIAL_POST_CHAR_LIMIT) return `Conteúdo deve ter até ${SOCIAL_POST_CHAR_LIMIT} caracteres`;
  if (containsBadWords(title) || containsBadWords(content)) return 'Conteúdo não permitido';
  return null;
}

// Helper: Check if user can edit/delete post
async function canModifyPost(req, postId) {
  const [rows] = await pool.query('SELECT author_id FROM social_posts WHERE id = ?', [postId]);
  if (!rows.length) return false;
  const isOwner = String(rows[0].author_id) === String(req.session.userId);
  const isAdmin = ['admin', 'dev'].includes(req.session.role);
  return isOwner || isAdmin;
}

// Helper: Check if user can edit/delete comment
async function canModifyComment(req, commentId) {
  const [rows] = await pool.query('SELECT author_id FROM social_comments WHERE id = ?', [commentId]);
  if (!rows.length) return false;
  const isOwner = String(rows[0].author_id) === String(req.session.userId);
  const isAdmin = ['admin', 'dev'].includes(req.session.role);
  return isOwner || isAdmin;
}

// Helper: Create notification
async function createNotification(recipientUserId, actorUserId, type, referenceType, referenceId, message) {
  if (String(recipientUserId) === String(actorUserId)) return; // Don''' notify self
  try {
    await pool.query(
      `INSERT INTO notifications (recipient_user_id, actor_user_id, type, reference_type, reference_id, message, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [recipientUserId, actorUserId, type, referenceType, referenceId, message, Date.now()]
    );
  } catch (e) { console.error('Notification creation error:', e); }
}

// ═══════════════════════════════════════════════════════════════
// POST ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// GET /api/social/posts — List posts with pagination
router.get('/posts', async (req, res) => {
  try {
    const type = req.query.type || 'forum'; // ''forum'' or ''update''
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const [posts] = await pool.query(
      `SELECT p.*, (SELECT COUNT(*) FROM social_post_likes WHERE post_id = p.id) as like_count,
              (SELECT COUNT(*) FROM social_comments WHERE post_id = p.id) as comment_count,
              (SELECT COUNT(*) FROM social_post_likes WHERE post_id = p.id AND user_id = ?) as liked_by_me
       FROM social_posts p
       WHERE p.type = ?
       ORDER BY p.is_pinned DESC, p.created_at DESC
       LIMIT ? OFFSET ?`,
      [req.session.userId || null, type, limit, offset]
    );

    // Load author details for all posts
    const postsWithAuthors = await Promise.all(posts.map(async p => {
      const author = await getUserDetails(p.author_id);
      return { ...p, author, liked_by_me: !!p.liked_by_me };
    }));

    // Get total count
    const [countRows] = await pool.query('SELECT COUNT(*) as cnt FROM social_posts WHERE type = ?', [type]);
    const total = countRows[0].cnt;

    res.json({ posts: postsWithAuthors, total, page, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/social/posts/:id — Get single post with author
router.get('/posts/:id', async (req, res) => {
  try {
    const postId = req.params.id;
    const [posts] = await pool.query(
      `SELECT p.*, (SELECT COUNT(*) FROM social_post_likes WHERE post_id = p.id) as like_count,
              (SELECT COUNT(*) FROM social_comments WHERE post_id = p.id) as comment_count,
              (SELECT COUNT(*) FROM social_post_likes WHERE post_id = p.id AND user_id = ?) as liked_by_me
       FROM social_posts p
       WHERE p.id = ?`,
      [req.session.userId || null, postId]
    );

    if (!posts.length) return res.status(404).json({ error: 'Post não encontrado' });

    const post = posts[0];
    const author = await getUserDetails(post.author_id);
    res.json({ ...post, author, liked_by_me: !!post.liked_by_me });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/social/posts — Create post (auth required)
router.post('/posts', requireAuth, async (req, res) => {
  try {
    const { title, content, type } = req.body;
    
    // Validate input
    const validationError = validateSocialContent(title, content);
    if (validationError) return res.status(400).json({ error: validationError });
    if (!['forum', 'update'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });

    // Permission check: only admin/dev can create updates
    if (type === 'update' && !['admin', 'dev'].includes(req.session.role)) {
      return res.status(403).json({ error: 'Apenas admins podem criar posts de atualização' });
    }

    const now = Date.now();
    const sanitizedTitle = sanitizeContent(title).substring(0, SOCIAL_TITLE_CHAR_LIMIT);
    const sanitized = sanitizeContent(content);
    
    const [result] = await pool.query(
      `INSERT INTO social_posts (author_id, title, content, type, is_pinned, is_locked, like_count, comment_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?)`,
      [req.session.userId, sanitizedTitle, sanitized, type, now, now]
    );

    const postId = result.insertId;
    const author = await getUserDetails(req.session.userId);

    // Generate notification if this is an update post
    if (type === 'update') {
      const [allUsers] = await pool.query('SELECT id FROM users');
      for (const user of allUsers) {
        if (String(user.id) !== String(req.session.userId)) {
          await createNotification(user.id, req.session.userId, 'NEW_UPDATE', 'update', postId, 'Uma nova atualização foi publicada');
        }
      }
    }

    res.status(201).json({
      id: postId,
      author_id: req.session.userId,
      title: title.substring(0, 500),
      content: sanitized,
      type,
      is_pinned: 0,
      is_locked: 0,
      like_count: 0,
      comment_count: 0,
      created_at: now,
      updated_at: now,
      author,
      liked_by_me: false
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/social/posts/:id — Edit post (owner or admin)
router.put('/posts/:id', requireAuth, async (req, res) => {
  try {
    const postId = req.params.id;
    const { title, content } = req.body;

    if (!await canModifyPost(req, postId)) {
      return res.status(403).json({ error: 'Você não pode editar este post' });
    }

    const now = Date.now();
    const updates = [];
    const values = [];

    if (title !== undefined && title.trim()) {
      if (title.trim().length > SOCIAL_TITLE_CHAR_LIMIT) {
        return res.status(400).json({ error: `Título deve ter até ${SOCIAL_TITLE_CHAR_LIMIT} caracteres` });
      }
      if (containsBadWords(title)) {
        return res.status(400).json({ error: 'Conteúdo não permitido' });
      }
      updates.push('title = ?');
      values.push(sanitizeContent(title).substring(0, SOCIAL_TITLE_CHAR_LIMIT));
    }
    if (content !== undefined && content.trim()) {
      if (content.trim().length > SOCIAL_POST_CHAR_LIMIT) {
        return res.status(400).json({ error: `Conteúdo deve ter até ${SOCIAL_POST_CHAR_LIMIT} caracteres` });
      }
      if (containsBadWords(content)) {
        return res.status(400).json({ error: 'Conteúdo não permitido' });
      }
      updates.push('content = ?');
      values.push(sanitizeContent(content));
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(postId);

    await pool.query(`UPDATE social_posts SET ${updates.join(', ')} WHERE id = ?`, values);

    // Return updated post
    const [posts] = await pool.query('SELECT * FROM social_posts WHERE id = ?', [postId]);
    const post = posts[0];
    const author = await getUserDetails(post.author_id);

    res.json({ ...post, author, liked_by_me: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/social/posts/:id — Delete post (owner or admin)
router.delete('/posts/:id', requireAuth, async (req, res) => {
  try {
    const postId = req.params.id;

    if (!await canModifyPost(req, postId)) {
      return res.status(403).json({ error: 'Você não pode deletar este post' });
    }

    // Delete related data
    await pool.query('DELETE FROM social_post_likes WHERE post_id = ?', [postId]);
    await pool.query('DELETE FROM social_comment_likes WHERE comment_id IN (SELECT id FROM social_comments WHERE post_id = ?)', [postId]);
    await pool.query('DELETE FROM social_comments WHERE post_id = ?', [postId]);
    await pool.query('DELETE FROM social_posts WHERE id = ?', [postId]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/social/posts/:id/pin — Pin post (admin/dev only)
router.post('/posts/:id/pin', requireAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    const [posts] = await pool.query('SELECT is_pinned FROM social_posts WHERE id = ?', [postId]);
    
    if (!posts.length) return res.status(404).json({ error: 'Post não encontrado' });

    const newState = posts[0].is_pinned ? 0 : 1;
    await pool.query('UPDATE social_posts SET is_pinned = ? WHERE id = ?', [newState, postId]);

    res.json({ ok: true, is_pinned: newState });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/social/posts/:id/lock — Lock post (admin/dev only)
router.post('/posts/:id/lock', requireAdmin, async (req, res) => {
  try {
    const postId = req.params.id;
    const [posts] = await pool.query('SELECT is_locked, author_id FROM social_posts WHERE id = ?', [postId]);
    
    if (!posts.length) return res.status(404).json({ error: 'Post não encontrado' });

    const newState = posts[0].is_locked ? 0 : 1;
    await pool.query('UPDATE social_posts SET is_locked = ? WHERE id = ?', [newState, postId]);

    // Notify post author if locked
    if (newState && String(posts[0].author_id) !== String(req.session.userId)) {
      await createNotification(
        posts[0].author_id,
        req.session.userId,
        'TOPIC_LOCKED',
        'forum',
        postId,
        'Seu tópico foi bloqueado'
      );
    }

    res.json({ ok: true, is_locked: newState });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/social/posts/:id/like — Like post
router.post('/posts/:id/like', requireAuth, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.session.userId;

    // Check if already liked
    const [existing] = await pool.query('SELECT id FROM social_post_likes WHERE user_id = ? AND post_id = ?', [userId, postId]);
    if (existing.length) {
      return res.status(400).json({ error: 'Você já curtiu este post' });
    }

    // Get post details
    const [posts] = await pool.query('SELECT author_id FROM social_posts WHERE id = ?', [postId]);
    if (!posts.length) return res.status(404).json({ error: 'Post não encontrado' });

    // Add like
    await pool.query('INSERT INTO social_post_likes (user_id, post_id, created_at) VALUES (?, ?, ?)',
      [userId, postId, Date.now()]);

    // Update like count
    const [counts] = await pool.query('SELECT COUNT(*) as cnt FROM social_post_likes WHERE post_id = ?', [postId]);
    await pool.query('UPDATE social_posts SET like_count = ? WHERE id = ?', [counts[0].cnt, postId]);

    // Create notification
    if (String(posts[0].author_id) !== String(userId)) {
      await createNotification(posts[0].author_id, userId, 'POST_LIKE', 'forum', postId, 'Alguém curtiu seu post');
    }

    res.json({ ok: true, like_count: counts[0].cnt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/social/posts/:id/like — Unlike post
router.delete('/posts/:id/like', requireAuth, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.session.userId;

    await pool.query('DELETE FROM social_post_likes WHERE user_id = ? AND post_id = ?', [userId, postId]);

    // Update like count
    const [counts] = await pool.query('SELECT COUNT(*) as cnt FROM social_post_likes WHERE post_id = ?', [postId]);
    await pool.query('UPDATE social_posts SET like_count = ? WHERE id = ?', [counts[0].cnt, postId]);

    res.json({ ok: true, like_count: counts[0].cnt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// COMMENT ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// GET /api/social/posts/:id/comments — Get comments with nested replies
router.get('/posts/:id/comments', async (req, res) => {
  try {
    const postId = req.params.id;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    // Get root comments
    const [comments] = await pool.query(
      `SELECT c.*, (SELECT COUNT(*) FROM social_comment_likes WHERE comment_id = c.id) as like_count,
              (SELECT COUNT(*) FROM social_comment_likes WHERE comment_id = c.id AND user_id = ?) as liked_by_me
       FROM social_comments c
       WHERE c.post_id = ? AND c.parent_comment_id IS NULL
       ORDER BY c.created_at ASC
       LIMIT ? OFFSET ?`,
      [req.session.userId || null, postId, limit, offset]
    );

    // Load authors and replies
    const commentsWithDetails = await Promise.all(comments.map(async comment => {
      const author = await getUserDetails(comment.author_id);
      
      // Get replies
      const [replies] = await pool.query(
        `SELECT c.*, (SELECT COUNT(*) FROM social_comment_likes WHERE comment_id = c.id) as like_count,
                (SELECT COUNT(*) FROM social_comment_likes WHERE comment_id = c.id AND user_id = ?) as liked_by_me
         FROM social_comments c
         WHERE c.parent_comment_id = ?
         ORDER BY c.created_at ASC`,
        [req.session.userId || null, comment.id]
      );

      const repliesWithAuthors = await Promise.all(replies.map(async r => {
        const rAuthor = await getUserDetails(r.author_id);
        return { ...r, author: rAuthor, liked_by_me: !!r.liked_by_me };
      }));

      return {
        ...comment,
        author,
        liked_by_me: !!comment.liked_by_me,
        replies: repliesWithAuthors
      };
    }));

    // Get total count of root comments
    const [countRows] = await pool.query('SELECT COUNT(*) as cnt FROM social_comments WHERE post_id = ? AND parent_comment_id IS NULL', [postId]);
    const total = countRows[0].cnt;

    res.json({ comments: commentsWithDetails, total, page, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/social/posts/:id/comments — Create comment
router.post('/posts/:id/comments', requireAuth, async (req, res) => {
  try {
    const postId = req.params.id;
    const { content, parentCommentId } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Conteúdo do comentário é obrigatório' });
    }
    if (content.trim().length > SOCIAL_COMMENT_CHAR_LIMIT) {
      return res.status(400).json({ error: `Comentário deve ter até ${SOCIAL_COMMENT_CHAR_LIMIT} caracteres` });
    }
    if (containsBadWords(content)) {
      return res.status(400).json({ error: 'Conteúdo não permitido' });
    }

    // Check if post exists and is not locked
    const [posts] = await pool.query('SELECT is_locked, author_id FROM social_posts WHERE id = ?', [postId]);
    if (!posts.length) return res.status(404).json({ error: 'Post não encontrado' });
    if (posts[0].is_locked) return res.status(403).json({ error: 'Este post está bloqueado' });

    const now = Date.now();
    const sanitized = sanitizeContent(content);

    // If replying to a comment, validate parent comment exists
    let parentId = null;
    let notifyUser = posts[0].author_id; // default: post author
    
    if (parentCommentId) {
      const [parentComments] = await pool.query('SELECT author_id FROM social_comments WHERE id = ? AND post_id = ?', [parentCommentId, postId]);
      if (!parentComments.length) return res.status(400).json({ error: 'Comentário pai não encontrado' });
      parentId = parentCommentId;
      notifyUser = parentComments[0].author_id; // notify comment author instead
    }

    const [result] = await pool.query(
      `INSERT INTO social_comments (post_id, author_id, parent_comment_id, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [postId, req.session.userId, parentId, sanitized, now, now]
    );

    // Update comment count on post
    const [counts] = await pool.query('SELECT COUNT(*) as cnt FROM social_comments WHERE post_id = ?', [postId]);
    await pool.query('UPDATE social_posts SET comment_count = ? WHERE id = ?', [counts[0].cnt, postId]);

    // Create notification
    const notificationType = parentId ? 'COMMENT_REPLY' : 'POST_COMMENT';
    const message = parentId ? 'Alguém respondeu seu comentário' : 'Alguém comentou seu post';
    if (String(notifyUser) !== String(req.session.userId)) {
      await createNotification(notifyUser, req.session.userId, notificationType, 'forum', postId, message);
    }

    const author = await getUserDetails(req.session.userId);
    res.status(201).json({
      id: result.insertId,
      post_id: postId,
      author_id: req.session.userId,
      parent_comment_id: parentId,
      content: sanitized,
      created_at: now,
      updated_at: now,
      like_count: 0,
      author,
      liked_by_me: false,
      replies: []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/social/comments/:id — Edit comment
router.put('/comments/:id', requireAuth, async (req, res) => {
  try {
    const commentId = req.params.id;
    const { content } = req.body;

    if (!await canModifyComment(req, commentId)) {
      return res.status(403).json({ error: 'Você não pode editar este comentário' });
    }

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Conteúdo é obrigatório' });
    }
    if (content.trim().length > SOCIAL_COMMENT_CHAR_LIMIT) {
      return res.status(400).json({ error: `Comentário deve ter até ${SOCIAL_COMMENT_CHAR_LIMIT} caracteres` });
    }
    if (containsBadWords(content)) {
      return res.status(400).json({ error: 'Conteúdo não permitido' });
    }

    const now = Date.now();
    const sanitized = sanitizeContent(content);

    await pool.query('UPDATE social_comments SET content = ?, updated_at = ? WHERE id = ?',
      [sanitized, now, commentId]);

    const [comments] = await pool.query('SELECT * FROM social_comments WHERE id = ?', [commentId]);
    const comment = comments[0];
    const author = await getUserDetails(comment.author_id);

    res.json({ ...comment, author, liked_by_me: false, replies: [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/social/comments/:id — Delete comment
router.delete('/comments/:id', requireAuth, async (req, res) => {
  try {
    const commentId = req.params.id;

    if (!await canModifyComment(req, commentId)) {
      return res.status(403).json({ error: 'Você não pode deletar este comentário' });
    }

    // Get post_id to update comment count
    const [comments] = await pool.query('SELECT post_id FROM social_comments WHERE id = ?', [commentId]);
    if (!comments.length) return res.status(404).json({ error: 'Comentário não encontrado' });
    const postId = comments[0].post_id;

    // Delete likes
    await pool.query('DELETE FROM social_comment_likes WHERE comment_id = ?', [commentId]);
    // Delete replies
    await pool.query('DELETE FROM social_comments WHERE parent_comment_id = ?', [commentId]);
    // Delete comment
    await pool.query('DELETE FROM social_comments WHERE id = ?', [commentId]);

    // Update comment count
    const [counts] = await pool.query('SELECT COUNT(*) as cnt FROM social_comments WHERE post_id = ?', [postId]);
    await pool.query('UPDATE social_posts SET comment_count = ? WHERE id = ?', [counts[0].cnt, postId]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/social/comments/:id/like — Like comment
router.post('/comments/:id/like', requireAuth, async (req, res) => {
  try {
    const commentId = req.params.id;
    const userId = req.session.userId;

    // Check if already liked
    const [existing] = await pool.query('SELECT id FROM social_comment_likes WHERE user_id = ? AND comment_id = ?', [userId, commentId]);
    if (existing.length) {
      return res.status(400).json({ error: 'Você já curtiu este comentário' });
    }

    // Get comment details
    const [comments] = await pool.query('SELECT author_id FROM social_comments WHERE id = ?', [commentId]);
    if (!comments.length) return res.status(404).json({ error: 'Comentário não encontrado' });

    // Add like
    await pool.query('INSERT INTO social_comment_likes (user_id, comment_id, created_at) VALUES (?, ?, ?)',
      [userId, commentId, Date.now()]);

    // Update like count
    const [counts] = await pool.query('SELECT COUNT(*) as cnt FROM social_comment_likes WHERE comment_id = ?', [commentId]);

    // Create notification
    if (String(comments[0].author_id) !== String(userId)) {
      await createNotification(comments[0].author_id, userId, 'COMMENT_LIKE', 'forum', commentId, 'Alguém curtiu seu comentário');
    }

    res.json({ ok: true, like_count: counts[0].cnt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/social/comments/:id/like — Unlike comment
router.delete('/comments/:id/like', requireAuth, async (req, res) => {
  try {
    const commentId = req.params.id;
    const userId = req.session.userId;

    await pool.query('DELETE FROM social_comment_likes WHERE user_id = ? AND comment_id = ?', [userId, commentId]);

    // Update like count
    const [counts] = await pool.query('SELECT COUNT(*) as cnt FROM social_comment_likes WHERE comment_id = ?', [commentId]);

    res.json({ ok: true, like_count: counts[0].cnt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
