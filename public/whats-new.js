(() => {
  const ANNOUNCEMENT_KEY = 'whats-new:project-view:v1:dismissed';
  const SLIDES = [
    {
      src: 'project-view/overview.png',
      alt: 'Project View overview with tracks, sessions, plan progress, todos, and attached folders',
      caption: 'Keep every track, session, plan, and follow-up together.',
    },
    {
      src: 'project-view/session.png',
      alt: 'Project View working session with a project strip, grouped session list, and terminal',
      caption: 'Work in a session without losing the project around it.',
    },
    {
      src: 'project-view/new-session-menu.png',
      alt: 'Project View new-session menu with Claude, Codex, and terminal launch choices',
      caption: 'Start Claude, Codex, or a terminal in the right project folder.',
    },
    {
      src: 'project-view/plan.png',
      alt: 'Project View plan with phases, linked sessions, and open todos',
      caption: 'See phase progress, linked sessions, and open todos at a glance.',
    },
  ];

  function shouldShowAnnouncement(storage) {
    try { return storage.getItem(ANNOUNCEMENT_KEY) !== '1'; }
    catch { return true; }
  }

  function markAnnouncementDismissed(storage) {
    try { storage.setItem(ANNOUNCEMENT_KEY, '1'); }
    catch {}
  }

  function wrappedSlideIndex(index, delta, length = SLIDES.length) {
    return (index + delta + length) % length;
  }

  function showProjectViewAnnouncement() {
    if (document.querySelector('.whats-new-overlay')) return null;

    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'whats-new-overlay modal-overlay';
    overlay.innerHTML = `
      <section class="whats-new-dialog" role="dialog" aria-modal="true" aria-labelledby="whats-new-title" aria-describedby="whats-new-description">
        <button type="button" class="whats-new-close" aria-label="Dismiss New Project View">&times;</button>
        <header class="whats-new-header">
          <div class="whats-new-kicker">What's new</div>
          <h2 id="whats-new-title">New Project View</h2>
          <p id="whats-new-description">Plan the work, organize agent sessions, and follow progress from one project workspace.</p>
        </header>
        <div class="whats-new-stage">
          <img class="whats-new-image" draggable="false">
          <button type="button" class="whats-new-arrow whats-new-arrow--previous" aria-label="Previous screenshot">&#8249;</button>
          <button type="button" class="whats-new-arrow whats-new-arrow--next" aria-label="Next screenshot">&#8250;</button>
        </div>
        <footer class="whats-new-footer">
          <div class="whats-new-slide-copy">
            <div class="whats-new-caption" aria-live="polite"></div>
            <div class="whats-new-dots" role="group" aria-label="Choose a screenshot"></div>
          </div>
          <button type="button" class="whats-new-dismiss">Dismiss</button>
        </footer>
      </section>`;

    const image = overlay.querySelector('.whats-new-image');
    const caption = overlay.querySelector('.whats-new-caption');
    const dots = overlay.querySelector('.whats-new-dots');
    let slideIndex = 0;

    for (let index = 0; index < SLIDES.length; index++) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'whats-new-dot';
      dot.setAttribute('aria-label', `Show screenshot ${index + 1} of ${SLIDES.length}`);
      dot.onclick = () => renderSlide(index);
      dots.appendChild(dot);
    }

    function renderSlide(index) {
      slideIndex = index;
      const slide = SLIDES[slideIndex];
      image.src = slide.src;
      image.alt = slide.alt;
      caption.textContent = slide.caption;
      [...dots.children].forEach((dot, dotIndex) => {
        const active = dotIndex === slideIndex;
        dot.classList.toggle('active', active);
        dot.setAttribute('aria-current', active ? 'true' : 'false');
      });
    }

    function move(delta) {
      renderSlide(wrappedSlideIndex(slideIndex, delta));
    }

    function dismiss() {
      markAnnouncementDismissed(window.localStorage);
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') dismiss();
      else if (event.key === 'ArrowLeft') move(-1);
      else if (event.key === 'ArrowRight') move(1);
      else return;
      event.preventDefault();
    }

    overlay.querySelector('.whats-new-arrow--previous').onclick = () => move(-1);
    overlay.querySelector('.whats-new-arrow--next').onclick = () => move(1);
    overlay.querySelector('.whats-new-close').onclick = dismiss;
    overlay.querySelector('.whats-new-dismiss').onclick = dismiss;
    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(overlay);
    renderSlide(0);
    overlay.querySelector('.whats-new-dismiss').focus();
    return overlay;
  }

  function maybeShowProjectViewAnnouncement() {
    if (!shouldShowAnnouncement(window.localStorage)) return;
    window.setTimeout(showProjectViewAnnouncement, 250);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      ANNOUNCEMENT_KEY,
      SLIDES,
      shouldShowAnnouncement,
      markAnnouncementDismissed,
      wrappedSlideIndex,
    };
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', maybeShowProjectViewAnnouncement, { once: true });
    else maybeShowProjectViewAnnouncement();
  }
})();
