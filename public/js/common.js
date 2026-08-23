/* Small shared helpers used by every page script. */
(function (window) {
  'use strict';

  /** POST JSON and always return a parsed body plus the HTTP status. */
  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });

    let data = {};
    try {
      data = await response.json();
    } catch (error) {
      data = { success: false, message: 'Unexpected server response. Please try again.' };
    }

    return { status: response.status, ok: response.ok, data: data };
  }

  async function getJson(url) {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });

    let data = {};
    try {
      data = await response.json();
    } catch (error) {
      data = { success: false };
    }

    return { status: response.status, ok: response.ok, data: data };
  }

  function showAlert(element, message, variant) {
    if (!element) return;
    element.textContent = message;
    element.className = 'alert alert--' + (variant || 'error');
    element.hidden = false;
  }

  function hideAlert(element) {
    if (element) element.hidden = true;
  }

  /** Formats a number of seconds as mm:ss, e.g. 227 -> "03:47". */
  function formatClock(totalSeconds) {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const minutes = String(Math.floor(safe / 60)).padStart(2, '0');
    const seconds = String(safe % 60).padStart(2, '0');
    return minutes + ':' + seconds;
  }

  /** Simple countdown driver. Calls onTick every second, onDone at zero. */
  function startCountdown(seconds, onTick, onDone) {
    let remaining = Math.max(0, Math.floor(seconds));
    onTick(remaining);

    if (remaining === 0) {
      if (onDone) onDone();
      return function stop() {};
    }

    const timer = setInterval(function () {
      remaining -= 1;
      onTick(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        if (onDone) onDone();
      }
    }, 1000);

    return function stop() {
      clearInterval(timer);
    };
  }

  /** Reveals the yellow demo panel. Only ever called with data the server sent. */
  function showDemoOtp(otp) {
    const panel = document.getElementById('demoPanel');
    const target = document.getElementById('demoOtp');
    if (!panel || !target || !otp) return;
    target.textContent = otp;
    panel.hidden = false;
  }

  window.GoCart = {
    postJson: postJson,
    getJson: getJson,
    showAlert: showAlert,
    hideAlert: hideAlert,
    formatClock: formatClock,
    startCountdown: startCountdown,
    showDemoOtp: showDemoOtp,
  };
})(window);
