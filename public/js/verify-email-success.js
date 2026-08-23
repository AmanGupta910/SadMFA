/* Auto-forwards to the dashboard a moment after the success screen appears,
   matching the reference flow ("You are now being redirected"). */
(function () {
  'use strict';

  setTimeout(function () {
    window.location.href = '/dashboard';
  }, 2500);
})();
