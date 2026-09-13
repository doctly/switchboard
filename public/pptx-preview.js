import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from '@aiden0z/pptx-renderer/browser';

// This page runs in an opaque sandbox, without the app's preload or file access.
// Only the selected deck's bytes are transferred in by ViewerPanel.
const controls = document.querySelector('nav');
const status = document.getElementById('status');
const scroll = document.getElementById('scroll');
const slides = document.getElementById('slides');
const slideInput = document.getElementById('slide');
const count = document.getElementById('count');
const previous = document.getElementById('previous');
const next = document.getElementById('next');
const zoom = document.getElementById('zoom');
const abort = new AbortController();
let viewer;
let loaded = false;
let busy = false;

function updateControls() {
  const index = viewer?.currentSlideIndex || 0;
  const total = viewer?.slideCount || 0;
  slideInput.value = String(index + 1);
  slideInput.max = String(total);
  count.textContent = `of ${total}`;
  previous.disabled = busy || index === 0;
  next.disabled = busy || index >= total - 1;
  slideInput.disabled = zoom.disabled = busy;
}

function showError(message) {
  status.textContent = message;
  status.className = 'error';
  status.hidden = false;
}

async function navigate(index) {
  if (!loaded || busy || !Number.isInteger(index)) return updateControls();
  busy = true;
  updateControls();
  try {
    await viewer.goToSlide(Math.max(0, Math.min(index, viewer.slideCount - 1)), { behavior: 'instant', block: 'start' });
  } catch {
    showError('This slide could not be displayed.');
  } finally {
    busy = false;
    updateControls();
  }
}

previous.addEventListener('click', () => navigate(viewer.currentSlideIndex - 1));
next.addEventListener('click', () => navigate(viewer.currentSlideIndex + 1));
slideInput.addEventListener('change', () => navigate(slideInput.valueAsNumber - 1));
zoom.addEventListener('change', async () => {
  if (!loaded || busy) return;
  busy = true;
  updateControls();
  try {
    const index = viewer.currentSlideIndex;
    await viewer.setZoom(Number(zoom.value));
    await viewer.goToSlide(index, { behavior: 'instant', block: 'start' });
  } catch {
    showError('The zoom could not be changed.');
  } finally {
    busy = false;
    updateControls();
  }
});
scroll.addEventListener('keydown', event => {
  if (!loaded || event.target !== scroll || event.altKey || event.ctrlKey || event.metaKey) return;
  const index = event.key === 'ArrowRight' ? viewer.currentSlideIndex + 1
    : event.key === 'ArrowLeft' ? viewer.currentSlideIndex - 1
    : event.key === 'Home' ? 0 : event.key === 'End' ? viewer.slideCount - 1 : null;
  if (index !== null) { event.preventDefault(); navigate(index); }
});

async function openPresentation(event) {
  if (event.source !== parent || event.data?.type !== 'switchboard-pptx') return;
  window.removeEventListener('message', openPresentation);
  try {
    const buffer = event.data.buffer;
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength || buffer.byteLength > 32 * 1024 * 1024) {
      throw new Error('Invalid presentation data');
    }
    viewer = new PptxViewer(slides, {
      scrollContainer: scroll,
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazySlides: true,
      lazyMedia: true,
      pdfjs: false,
      onSlideChange: updateControls,
      onSlideError: index => showError(`Slide ${index + 1} could not be displayed. Other slides are still available.`),
    });
    await viewer.open(buffer, {
      signal: abort.signal,
      listOptions: { windowed: true, initialSlides: 2, batchSize: 2, showSlideLabels: true },
    });
    if (!viewer.slideCount) throw new Error('The presentation contains no slides');
    loaded = true;
    // Keep partial-slide errors visible after opening.
    if (status.className !== 'error') status.hidden = true;
    controls.hidden = false;
    updateControls();
  } catch {
    if (abort.signal.aborted) return;
    viewer?.destroy();
    controls.hidden = true;
    showError('This presentation could not be previewed. It may be damaged, password protected, or exceed preview limits.');
  }
}

// Deck hyperlinks must not navigate this frame away from the preview.
document.addEventListener('click', event => {
  if (event.target.closest?.('a')) event.preventDefault();
}, true);
window.addEventListener('message', openPresentation);
window.addEventListener('pagehide', () => { abort.abort(); viewer?.destroy(); }, { once: true });
