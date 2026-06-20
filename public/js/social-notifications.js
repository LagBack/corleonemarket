
// ═══════════════════════════════════════════════════════════════
// SOCIAL SYSTEM & NOTIFICATIONS — Frontend Implementation (v6.0)
// ═══════════════════════════════════════════════════════════════

// Global state
let currentSocialTab = 'forum';
let currentSocialPage = 1;
let currentSocialType = 'forum';
let openPostId = null;
let notificationsLoaded = false;

// ─── SOCIAL TAB SWITCHING ───
function showSocialTab(tab) {
  currentSocialTab = tab;
  currentSocialType = tab === 'updates' ? 'update' : 'forum';
  currentSocialPage = 1;
  
  document.querySelectorAll('.social-tab').forEach(b => b.classList.remove('active'));
  document.querySelector(`.social-tab[data-tab="${tab}"]`).classList.add('active');
  
  if (tab === 'updates') {
    document.getElementById('social-composer').style.display = CU && ['admin', 'dev'].includes(CU.role) ? '' : 'none';
  } else {
    document.getElementById('social-composer').style.display = CU ? '' : 'none';
  }
  
  loadSocialPage(1);
}

// ─── LOAD SOCIAL PAGE ───
async function loadSocialPage(page) {
  try {
    setPageLoading('social', true);
    const type = currentSocialType;
    const { posts, total } = await GET(`social/posts?type=${type}&page=${page}&limit=20`);
    
    currentSocialPage = page;
    renderSocialPosts(posts);
    updateSocialPagination(total, page);
  } catch (e) {
    showMsg('social-posts-list', e.message, 'err');
  } finally {
    setPageLoading('social', false);
  }
}

// ─── RENDER POSTS ───
function renderSocialPosts(posts) {
  const list = document.getElementById('social-posts-list');
  if (!posts.length) {
    list.innerHTML = '<p class="page-hint">Nenhum post ainda.</p>';
    return;
  }
  
  list.innerHTML = posts.map(p => {
    const isOwner = CU && String(CU.id) === String(p.author_id);
    const isAdmin = CU && ['admin', 'dev'].includes(CU.role);
    const createdDate = new Date(p.created_at).toLocaleDateString('pt-BR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const isPinned = p.is_pinned ? '📌' : '';
    const isLocked = p.is_locked ? '🔒' : '';
    const likedClass = p.liked_by_me ? 'liked' : '';
    
    const authorEmoji = p.author ? (p.author.avatar || '🦁') : '🦁';
    const authorPhoto = p.author && p.author.photo ? `<img src="${p.author.photo}" alt="${authorEmoji}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" onerror="this.outerHTML='${authorEmoji}'">` : `<span style="font-size:24px;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;background:var(--s3)">${authorEmoji}</span>`;
    return `<div class="card social-post-card" style="margin-bottom:14px;cursor:pointer" onclick="openSocialPost(${p.id})">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="flex-shrink:0">${authorPhoto}</div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span style="font-weight:600;font-size:13px">${p.author ? p.author.nick || p.author.name : 'Anônimo'}</span>
            ${p.author && p.author.role !== 'user' ? `<span style="font-size:9px;padding:1px 6px;background:var(--gold-dim);color:var(--gold);border-radius:3px">${p.author.role.toUpperCase()}</span>` : ''}
            <span style="font-size:11px;color:var(--text3)">${createdDate}</span>
            ${isPinned}<${isLocked}
          </div>
          <h3 style="font-size:15px;font-weight:700;margin-bottom:6px;color:var(--text)">${p.title}</h3>
          <p style="font-size:12px;color:var(--text2);line-height:1.5;max-height:80px;overflow:hidden;text-overflow:ellipsis">${p.content.substring(0, 200)}</p>
          <div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:var(--text3)">
            <span>❤️ ${p.like_count || 0}</span>
            <span>💬 ${p.comment_count || 0}</span>
          </div>
        </div>
        ${isAdmin ? `<div style="display:flex;gap:4px;flex-direction:column">
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();togglePinPost(${p.id})" title="Pin">${p.is_pinned ? '📌' : '○'}</button>
          <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();toggleLockPost(${p.id})" title="Lock">${p.is_locked ? '🔒' : '○'}</button>
          ${isOwner ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();deleteSocialPost(${p.id})" title="Delete">🗑️</button>` : ''}
        </div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ─── UPDATE PAGINATION ───
function updateSocialPagination(total, page) {
  const paginationDiv = document.getElementById('social-pagination');
  if (total <= 20) {
    paginationDiv.style.display = 'none';
    return;
  }
  
  const maxPage = Math.ceil(total / 20);
  document.getElementById('social-page-info').textContent = `Página ${page} de ${maxPage}`;
  paginationDiv.style.display = 'flex';
}

// ─── OPEN POST DETAIL ───
async function openSocialPost(postId) {
  try {
    const post = await GET(`social/posts/${postId}`);
    openPostId = postId;
    
    const detailDiv = document.getElementById('social-post-detail');
    const isOwner = CU && String(CU.id) === String(post.author_id);
    const isAdmin = CU && ['admin', 'dev'].includes(CU.role);
    
    const detailPhoto = post.author && post.author.photo ? `<img src="${post.author.photo}" alt="${post.author.nick || post.author.name || 'Avatar'}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;">` : `<span style="font-size:32px;display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background:var(--s3)">${post.author ? (post.author.avatar || '🦁') : '🦁'}</span>`;
    detailDiv.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:16px">
        <div style="flex-shrink:0">${detailPhoto}</div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span style="font-weight:600;font-size:14px">${post.author ? post.author.nick || post.author.name : 'Anônimo'}</span>
            ${post.author && post.author.role !== 'user' ? `<span style="font-size:10px;padding:2px 8px;background:var(--gold-dim);color:var(--gold);border-radius:3px;text-transform:uppercase">${post.author.role}</span>` : ''}
          </div>
          <div style="font-size:11px;color:var(--text3)">${new Date(post.created_at).toLocaleDateString('pt-BR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        ${isOwner || isAdmin ? `<div style="display:flex;gap:4px">
          ${isOwner ? `<button class="btn btn-ghost btn-sm" onclick="editSocialPost(${postId})">✏️</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteSocialPost(${postId})">🗑️</button>` : ''}
        </div>` : ''}
      </div>
      <h2 style="font-family:'Playfair Display',serif;font-size:22px;font-weight:700;margin-bottom:12px">${post.title}</h2>
      <div style="font-size:13px;line-height:1.8;color:var(--text2);margin-bottom:16px;word-wrap:break-word">${post.content}</div>
      <div style="display:flex;gap:16px;padding:12px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <button class="btn btn-ghost btn-sm" onclick="toggleLikeSocialPost(${postId})" ${!CU ? 'disabled' : ''} style="gap:4px">
          ${post.liked_by_me ? '❤️' : '🤍'} ${post.like_count || 0}
        </button>
        <button class="btn btn-ghost btn-sm" onclick="showCommentArea()" ${!CU ? 'disabled' : ''}>💬 Comentar</button>
      </div>
    `;
    
    document.getElementById('social-comment-input-area').style.display = CU ? '' : 'none';
    loadSocialComments(postId);
    
    document.getElementById('social-post-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    window.location.hash = `#/social/${currentSocialType === 'update' ? 'updates' : 'forum'}/post/${postId}`;
  } catch (e) {
    showMsg('social-post-detail', e.message, 'err');
  }
}

// ─── LOAD COMMENTS ───
async function loadSocialComments(postId) {
  try {
    const { comments } = await GET(`social/posts/${postId}/comments?limit=50`);
    renderSocialComments(comments);
  } catch (e) {
    document.getElementById('social-comments-list').innerHTML = `<p style="color:var(--red2);font-size:11px">${e.message}</p>`;
  }
}

// ─── RENDER COMMENTS ───
function renderSocialComments(comments) {
  const list = document.getElementById('social-comments-list');
  if (!comments.length) {
    list.innerHTML = '<p class="page-hint" style="margin:0">Nenhum comentário ainda.</p>';
    return;
  }
  
  list.innerHTML = comments.map(c => renderCommentThread(c, 0)).join('');
}

// ─── RENDER COMMENT THREAD ───
function renderCommentThread(comment, depth = 0) {
  const isOwner = CU && String(CU.id) === String(comment.author_id);
  const isAdmin = CU && ['admin', 'dev'].includes(CU.role);
  const margin = depth > 0 ? `margin-left:${depth * 16}px` : '';
  const createdDate = new Date(comment.created_at).toLocaleDateString('pt-BR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  
  let html = `<div style="${margin};padding:10px 0;border-bottom:1px solid rgba(255,255,255,.05)">
    <div style="display:flex;gap:8px">
      <span style="font-size:16px;flex-shrink:0">${comment.author ? (comment.author.avatar || '🦁') : '🦁'}</span>
      <div style="flex:1">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">
          <strong>${comment.author ? comment.author.nick || comment.author.name : 'Anônimo'}</strong> · ${createdDate}
        </div>
        <p style="font-size:12px;line-height:1.6;margin-bottom:6px">${comment.content}</p>
        <div style="display:flex;gap:8px;font-size:11px">
          <button class="btn btn-ghost btn-sm" onclick="toggleLikeSocialComment(${comment.id})" ${!CU ? 'disabled' : ''} style="gap:4px">
            ${comment.liked_by_me ? '❤️' : '🤍'} ${comment.like_count || 0}
          </button>
          ${isOwner || isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="deleteSocialComment(${comment.id})">🗑️</button>` : ''}
        </div>
      </div>
    </div>
  </div>`;
  
  if (comment.replies && comment.replies.length) {
    html += comment.replies.map(r => renderCommentThread(r, depth + 1)).join('');
  }
  
  return html;
}

// ─── LIKE POST ───
async function toggleLikeSocialPost(postId) {
  return withActionLock(`likePost${postId}`, async () => {
    try {
      if (openPostId === postId) {
        const post = await GET(`social/posts/${postId}`);
        if (post.liked_by_me) {
          await DEL(`social/posts/${postId}/like`);
        } else {
          await POST(`social/posts/${postId}/like`);
        }
        openSocialPost(postId);
      }
    } catch (e) {
      showMsg('social-post-detail', e.message, 'err');
    }
  });
}

// ─── LIKE COMMENT ───
async function toggleLikeSocialComment(commentId) {
  return withActionLock(`likeComment${commentId}`, async () => {
    try {
      const post = await GET(`social/posts/${openPostId}`);
      const cmtLiked = post.comments && post.comments.find(c => c.id === commentId)?.liked_by_me;
      if (cmtLiked) {
        await DEL(`social/comments/${commentId}/like`);
      } else {
        await POST(`social/comments/${commentId}/like`);
      }
      loadSocialComments(openPostId);
    } catch (e) {
      showMsg('social-comments-list', e.message, 'err');
    }
  });
}

// ─── COMMENT FUNCTIONS ───
function showCommentArea() {
  document.getElementById('social-comment-input-area').style.display = '';
  document.getElementById('social-comment-text').focus();
}

function closeCommentArea() {
  document.getElementById('social-comment-input-area').style.display = 'none';
  document.getElementById('social-comment-text').value = '';
}

async function submitComment() {
  const content = document.getElementById('social-comment-text').value.trim();
  if (!content) return showMsg('social-comment-text', 'Escreva um comentário', 'err');
  
  const btn = document.getElementById('social-comment-submit-btn');
  setBtnBusy(btn, true, 'Comentando…');
  try {
    await POST(`social/posts/${openPostId}/comments`, { content, parentCommentId: null });
    closeCommentArea();
    loadSocialComments(openPostId);
  } catch (e) {
    showMsg('social-comment-text', e.message, 'err');
  } finally {
    setBtnBusy(btn, false);
  }
}

// ─── PUBLISH POST ───
async function publishSocialPost() {
  const title = document.getElementById('social-title-input').value.trim();
  const content = document.getElementById('social-content-input').value.trim();
  
  if (!title) return showMsg('social-title-input', 'Título é obrigatório', 'err');
  if (!content) return showMsg('social-content-input', 'Conteúdo é obrigatório', 'err');
  
  const btn = document.getElementById('social-publish-btn');
  setBtnBusy(btn, true, 'Publicando…');
  try {
    await POST('social/posts', { title, content, type: currentSocialType });
    document.getElementById('social-title-input').value = '';
    document.getElementById('social-content-input').value = '';
    closeSocialComposer();
    loadSocialPage(1);
    showMsg('social-posts-list', '✓ Post publicado!', 'ok');
  } catch (e) {
    showMsg('social-title-input', e.message, 'err');
  } finally {
    setBtnBusy(btn, false);
  }
}

function closeSocialComposer() {
  document.getElementById('social-composer').style.display = 'none';
}

// ─── EDIT/DELETE POST ───
async function editSocialPost(postId) {
  alert('Edição de posts em desenvolvimento. Por favor, delete e recrie.');
}

async function deleteSocialPost(postId) {
  if (!confirm('Tem certeza? Esta ação não pode ser desfeita.')) return;
  try {
    await DEL(`social/posts/${postId}`);
    closeSocialModal();
    loadSocialPage(currentSocialPage);
    showMsg('social-posts-list', '✓ Post deletado', 'ok');
  } catch (e) {
    showMsg('social-post-detail', e.message, 'err');
  }
}

async function deleteSocialComment(commentId) {
  if (!confirm('Deletar comentário?')) return;
  try {
    await DEL(`social/comments/${commentId}`);
    loadSocialComments(openPostId);
  } catch (e) {
    showMsg('social-comments-list', e.message, 'err');
  }
}

async function togglePinPost(postId) {
  try {
    await POST(`social/posts/${postId}/pin`);
    loadSocialPage(currentSocialPage);
  } catch (e) {
    showMsg('social-posts-list', e.message, 'err');
  }
}

async function toggleLockPost(postId) {
  try {
    await POST(`social/posts/${postId}/lock`);
    openSocialPost(postId);
  } catch (e) {
    showMsg('social-post-detail', e.message, 'err');
  }
}

// ─── MODAL CONTROL ───
function closeSocialModal() {
  document.getElementById('social-post-modal').style.display = 'none';
  document.body.style.overflow = '';
  openPostId = null;
  window.location.hash = `#/social/${currentSocialType === 'update' ? 'updates' : 'forum'}`;
}

// ─── NOTIFICATION FUNCTIONS ───
async function loadNotifications(forceRefresh = false) {
  if (notificationsLoaded && !forceRefresh) return;
  
  try {
    const { notifications } = await GET('notifications?limit=20');
    renderNotifications(notifications);
    notificationsLoaded = true;
    updateNotificationBadge();
  } catch (e) {
    console.error('Notification load error:', e);
  }
}

function renderNotifications(notifications) {
  const list = document.getElementById('notif-list');
  const empty = document.getElementById('notif-empty');
  
  if (!notifications.length) {
    list.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  
  list.style.display = 'flex';
  empty.style.display = 'none';
  list.innerHTML = notifications.map(n => `
    <div style="padding:12px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .15s;background:${n.is_read ? 'transparent' : 'var(--gold-dim)'}" onmouseover="this.style.background='var(--s2)'" onmouseout="this.style.background='${n.is_read ? 'transparent' : 'var(--gold-dim)'}'">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1">
          <div style="font-size:12px;font-weight:600;margin-bottom:2px">${n.message}</div>
          <div style="font-size:10px;color:var(--text3)">${new Date(n.created_at).toLocaleDateString('pt-BR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();deleteNotification(${n.id})" style="font-size:10px;padding:2px 6px">×</button>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="openNotificationLink(${n.id})" style="width:100%;margin-top:6px;justify-content:center;font-size:10px">Ver</button>
    </div>
  `).join('');
}

async function updateNotificationBadge() {
  try {
    const { unread_count } = await GET('notifications/unread-count');
    const badge = document.getElementById('notif-badge');
    if (unread_count > 0) {
      badge.textContent = unread_count;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  } catch (e) {
    console.error('Badge update error:', e);
  }
}

async function toggleNotifMenu() {
  const menu = document.getElementById('notif-menu');
  const isOpen = menu.style.display !== 'none';
  
  if (!isOpen) {
    await loadNotifications(true);
  }
  
  menu.style.display = isOpen ? 'none' : 'flex';
}

async function markAllRead() {
  try {
    await POST('notifications/read-all');
    await loadNotifications(true);
    updateNotificationBadge();
  } catch (e) {
    console.error('Mark all read error:', e);
  }
}

async function deleteNotification(notificationId) {
  try {
    await DEL(`notifications/${notificationId}`);
    await loadNotifications(true);
    updateNotificationBadge();
  } catch (e) {
    console.error('Delete notification error:', e);
  }
}

async function openNotificationLink(notificationId) {
  try {
    // Mark as read
    await POST(`notifications/${notificationId}/read`);
    
    // Get the notification to find the link
    const { notifications } = await GET('notifications?limit=50');
    const notif = notifications.find(n => n.id === notificationId);
    
    if (!notif) return;
    
    // Navigate based on type
    if (notif.reference_type === 'update') {
      showPage('social');
      currentSocialType = 'update';
      currentSocialTab = 'updates';
      showSocialTab('updates');
      setTimeout(() => openSocialPost(notif.reference_id), 500);
    } else {
      showPage('social');
      currentSocialType = 'forum';
      currentSocialTab = 'forum';
      showSocialTab('forum');
      setTimeout(() => openSocialPost(notif.reference_id), 500);
    }
    
    document.getElementById('notif-menu').style.display = 'none';
    await loadNotifications(true);
    updateNotificationBadge();
  } catch (e) {
    console.error('Open notification error:', e);
  }
}

// ─── HASH ROUTER FOR FRIENDLY URLs ───
window.addEventListener('hashchange', () => {
  const hash = window.location.hash.substring(1);
  if (!hash.startsWith('/social')) return;
  
  const parts = hash.split('/');
  const tab = parts[2] === 'updates' ? 'updates' : 'forum';
  
  if (parts[3] === 'post' && parts[4]) {
    showPage('social');
    showSocialTab(tab);
    setTimeout(() => openSocialPost(parseInt(parts[4])), 300);
  } else {
    showPage('social');
    showSocialTab(tab);
  }
});

// Close notification menu on outside click
document.addEventListener('click', (e) => {
  const notifWrap = document.getElementById('notif-wrap');
  const notifMenu = document.getElementById('notif-menu');
  if (notifWrap && notifMenu && !notifWrap.contains(e.target)) {
    notifMenu.style.display = 'none';
  }
});

// Close social modal on ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('social-post-modal').style.display !== 'none') {
    closeSocialModal();
  }
});

// Update notification badge on app start
function initNotifications() {
  updateNotificationBadge();
  // Check for new notifications every 30 seconds
  setInterval(() => {
    if (!document.hidden) {
      updateNotificationBadge();
    }
  }, 30000);
}

// Call this after user logs in
const originalStartApp = startApp;
startApp = async function() {
  await originalStartApp.call(this);
  initNotifications();
};

