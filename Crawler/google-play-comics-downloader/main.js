// Google Play Books Real-time Image Downloader - Console Ready Version

document.body.offsetHeight;

(function () {
  'use strict';

  // Auto-downloads images as soon as they are collected
  class ImageDownloader {
    constructor() {
      this.collectedUrls = new Set();
      this.intervalId = null;
      this.downloadQueue = [];
      this.isDownloading = false;
      this.isPaused = false;
      this.downloadDelay = 3000; // Default 3 seconds
      this.downloadCount = 0;

      // Auto-scroll properties
      this.scrollIntervalId = null;
      this.isAutoScrolling = false;
      this.scrollDelay = 2000; // Default 2 seconds between scrolls
      this.scrollStep = 800; // Default scroll step in pixels
      this.lastScrollPosition = 0;
      this.noChangeCount = 0;
      this.maxNoChangeCount = 5; // Stop if scroll position doesn't change for 5 consecutive checks
    }

    // Collect images from current page and auto-download new ones
    collectImages() {
      const images = document.querySelectorAll("image");
      let newCount = 0;
      const newUrls = [];

      images.forEach(img => {
        const url = img.getAttribute('xlink:href');
        if (url && url.startsWith('blob:') && !this.collectedUrls.has(url)) {
          this.collectedUrls.add(url);
          newUrls.push(url);
          newCount++;
        }
      });

      if (newCount > 0) {
        console.log(`Found ${newCount} new images, total: ${this.collectedUrls.size}`);
        // Add new images to download queue
        newUrls.forEach(url => this.addToQueue(url));
      }

      return newCount;
    }

    // Add image to download queue
    addToQueue(url) {
      if (!this.isPaused) {
        this.downloadQueue.push(url);
        this.processQueue();
      }
    }

    // Process download queue
    processQueue() {
      if (this.isDownloading || this.isPaused || this.downloadQueue.length === 0) {
        return;
      }

      this.isDownloading = true;
      const url = this.downloadQueue.shift();
      this.downloadCount++;

      console.log(`Starting download ${this.downloadCount}: ${this.downloadQueue.length} remaining in queue`);
      this.downloadImage(url, this.downloadCount);
    }

    // Download single image using XMLHttpRequest
    downloadImage(url, downloadNumber) {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.responseType = 'blob';

      xhr.onload = () => {
        if (xhr.status === 200) {
          const blob = xhr.response;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `image_${downloadNumber}.png`;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          // Clean up blob URL
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);

          console.log(`Downloaded image ${downloadNumber}`);
        } else {
          console.error(`Failed to download image ${downloadNumber}: HTTP ${xhr.status}`);
        }

        // Mark download as complete and process next
        this.isDownloading = false;

        // Wait before processing next download
        setTimeout(() => {
          this.processQueue();
        }, this.downloadDelay);
      };

      xhr.onerror = () => {
        console.error(`Network error downloading image ${downloadNumber}`);
        this.isDownloading = false;
        // Continue with next download after error
        setTimeout(() => {
          this.processQueue();
        }, this.downloadDelay);
      };

      xhr.ontimeout = () => {
        console.error(`Timeout downloading image ${downloadNumber}`);
        this.isDownloading = false;
        // Continue with next download after timeout
        setTimeout(() => {
          this.processQueue();
        }, this.downloadDelay);
      };

      xhr.timeout = 30000; // 30 second timeout
      xhr.send();
    }

    // Get virtual scroll viewport
    getScrollViewport() {
      return document.querySelector('.cdk-virtual-scroll-viewport');
    }

    // Get current scroll position
    getScrollPosition() {
      const viewport = this.getScrollViewport();
      if (viewport) {
        return viewport.scrollTop;
      }
      return window.pageYOffset || document.documentElement.scrollTop;
    }

    // Check if reached end of book
    isEndOfBook() {
      const endOfBook = document.querySelector('reader-end-of-book');
      return endOfBook && endOfBook.offsetTop < window.innerHeight + window.pageYOffset;
    }

    // Auto-scroll to load more content
    autoScroll() {
      if (!this.isAutoScrolling) {
        return;
      }

      const viewport = this.getScrollViewport();
      if (!viewport) {
        console.log('Virtual scroll viewport not found');
        this.stopAutoScroll();
        return;
      }

      const currentPosition = this.getScrollPosition();

      // Check if we've reached the end
      if (this.isEndOfBook()) {
        console.log('Reached end of book, stopping auto-scroll');
        this.stopAutoScroll();
        return;
      }

      // Check if scroll position hasn't changed
      if (currentPosition === this.lastScrollPosition) {
        this.noChangeCount++;
        if (this.noChangeCount >= this.maxNoChangeCount) {
          console.log('Scroll position unchanged for too long, stopping auto-scroll');
          this.stopAutoScroll();
          return;
        }
      } else {
        this.noChangeCount = 0;
      }

      this.lastScrollPosition = currentPosition;

      // Scroll down
      const newPosition = currentPosition + this.scrollStep;
      viewport.scrollTo({
        top: newPosition,
        behavior: 'smooth'
      });

      console.log(`Auto-scrolled to position ${newPosition}`);
    }

    // Start auto-scrolling
    startAutoScroll() {
      if (this.scrollIntervalId) {
        console.log('Auto-scroll already running...');
        return;
      }

      this.isAutoScrolling = true;
      this.lastScrollPosition = this.getScrollPosition();
      this.noChangeCount = 0;

      this.scrollIntervalId = setInterval(() => this.autoScroll(), this.scrollDelay);
      console.log(`Started auto-scrolling (${this.scrollDelay}ms intervals, ${this.scrollStep}px steps)`);
    }

    // Stop auto-scrolling
    stopAutoScroll() {
      if (this.scrollIntervalId) {
        clearInterval(this.scrollIntervalId);
        this.scrollIntervalId = null;
        this.isAutoScrolling = false;
        console.log('Stopped auto-scrolling');
      } else {
        console.log('Auto-scroll not running');
      }
    }

    // Set scroll delay in milliseconds
    setScrollDelay(milliseconds) {
      this.scrollDelay = milliseconds;
      console.log(`Scroll delay set to ${milliseconds}ms`);
    }

    // Set scroll step in pixels
    setScrollStep(pixels) {
      this.scrollStep = pixels;
      console.log(`Scroll step set to ${pixels}px`);
    }

    // Start real-time collecting and downloading
    startDownload() {
      if (this.intervalId) {
        console.log('Already running...');
        return;
      }

      this.intervalId = setInterval(() => this.collectImages(), 2000);
      console.log('Started real-time collecting and downloading...');
      this.collectImages(); // Run immediately
    }

    // Stop real-time collecting
    stopDownload() {
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
        console.log('Stopped real-time collecting');
      } else {
        console.log('Not currently running');
      }
    }

    // Pause downloading (but continue collecting)
    pauseDownload() {
      this.isPaused = true;
      console.log('Download paused (collecting continues)');
    }

    // Resume downloading
    resumeDownload() {
      if (!this.isPaused) {
        console.log('Download is not paused');
        return;
      }

      this.isPaused = false;
      console.log('Download resumed');
      this.processQueue(); // Process any queued downloads
    }

    // Set download delay in milliseconds
    setDownloadDelay(milliseconds) {
      this.downloadDelay = milliseconds;
      console.log(`Download delay set to ${milliseconds}ms`);
    }

    // Get current status
    getStatus() {
      return {
        collected: this.collectedUrls.size,
        downloaded: this.downloadCount,
        queueLength: this.downloadQueue.length,
        isCollecting: !!this.intervalId,
        isDownloading: this.isDownloading,
        isPaused: this.isPaused,
        downloadDelay: this.downloadDelay,
        isAutoScrolling: this.isAutoScrolling,
        scrollDelay: this.scrollDelay,
        scrollStep: this.scrollStep,
        currentScrollPosition: this.getScrollPosition(),
        isEndOfBook: this.isEndOfBook()
      };
    }

    // Clear all data
    clearAll() {
      this.collectedUrls.clear();
      this.downloadQueue = [];
      this.downloadCount = 0;
      console.log('Cleared all data');
    }
  }

  // Create global instance
  const downloader = new ImageDownloader();

  // Expose functions to global scope for console access
  window.startDownload = () => downloader.startDownload();
  window.stopDownload = () => downloader.stopDownload();
  window.pauseDownload = () => downloader.pauseDownload();
  window.resumeDownload = () => downloader.resumeDownload();
  window.setDelay = (ms) => downloader.setDownloadDelay(ms);
  window.getStatus = () => downloader.getStatus();
  window.clearAll = () => downloader.clearAll();

  // Auto-scroll functions
  window.startAutoScroll = () => downloader.startAutoScroll();
  window.stopAutoScroll = () => downloader.stopAutoScroll();
  window.setScrollDelay = (ms) => downloader.setScrollDelay(ms);
  window.setScrollStep = (px) => downloader.setScrollStep(px);

  // Usage instructions
  console.log('=== Real-time Image Downloader ===');
  console.log('startDownload() - Start real-time collecting and downloading');
  console.log('stopDownload() - Stop collecting');
  console.log('pauseDownload() - Pause downloading (keep collecting)');
  console.log('resumeDownload() - Resume downloading');
  console.log('setDelay(ms) - Set download interval (default 3000ms)');
  console.log('getStatus() - Show current status');
  console.log('clearAll() - Clear all data');
  console.log('');
  console.log('=== Auto-scroll Functions ===');
  console.log('startAutoScroll() - Start auto-scrolling to load more content');
  console.log('stopAutoScroll() - Stop auto-scrolling');
  console.log('setScrollDelay(ms) - Set scroll interval (default 2000ms)');
  console.log('setScrollStep(px) - Set scroll step size (default 800px)');
  console.log('');
  console.log('Ready! Try: startDownload() + startAutoScroll()');

})();