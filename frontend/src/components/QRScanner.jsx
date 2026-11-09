import React, { useEffect, useId, useRef } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';

// html5-qrcode owns the camera and mutates its container. Serialising its
// lifecycle prevents React re-renders (including Strict Mode) from starting a
// second camera preview before the previous one has been released.
let activeScanner = null;
let scannerTransition = Promise.resolve();

async function clearScanner(scanner) {
  try {
    await scanner.clear();
  } catch {
    // The scanner may already have released its camera during unmount.
  }
}

export default function QRScanner({ onScan, onError }) {
  const id = useId().replace(/:/g, '');
  const onScanRef = useRef(onScan);
  const onErrorRef = useRef(onError);
  onScanRef.current = onScan;
  onErrorRef.current = onError;

  useEffect(() => {
    let disposed = false;
    let scanner = null;
    let scanned = false;

    scannerTransition = scannerTransition.then(async () => {
      if (disposed) return;

      if (activeScanner) {
        await clearScanner(activeScanner);
        activeScanner = null;
      }

      const container = document.getElementById(id);
      if (!container || disposed) return;
      container.replaceChildren();

      scanner = new Html5QrcodeScanner(
        id,
        { fps: 10, qrbox: { width: 240, height: 180 } },
        false
      );
      activeScanner = scanner;
      scanner.render(
        (decodedText) => {
          if (disposed || scanned) return;
          scanned = true;
          onScanRef.current(decodedText);
        },
        () => {}
      );
    }).catch((error) => {
      if (!disposed) onErrorRef.current?.(error?.message || 'Could not start the camera scanner');
    });

    return () => {
      disposed = true;
      scannerTransition = scannerTransition.then(async () => {
        if (activeScanner === scanner) {
          activeScanner = null;
          await clearScanner(scanner);
        }
      });
    };
  }, [id]);
  return <div><div id={id} /><p className="muted">Camera permission is required. Use HTTPS in production.</p></div>;
}
