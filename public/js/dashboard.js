/* Logout. Sent as POST so a stray GET (a prefetch, an image tag) cannot end
   somebody's session. */
(function () {
  'use strict';

  async function logout() {
    try {
      const result = await GoCart.postJson('/api/auth/logout', {});
      window.location.href = (result.data && result.data.redirect) || '/login?reason=logged_out';
    } catch (error) {
      window.location.href = '/login';
    }
  }

  ['logoutBtn', 'logoutLink'].forEach(function (id) {
    const element = document.getElementById(id);
    if (element) element.addEventListener('click', logout);
  });
})();
