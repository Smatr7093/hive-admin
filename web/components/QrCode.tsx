'use client';

/**
 * QR code for the TOTP enrolment URI.
 *
 * This uses the `qrcode` package rather than a hand-rolled encoder. The general
 * principle on this surface is to keep dependencies minimal, but QR encoding is
 * Reed-Solomon plus a mask-selection algorithm, and a subtly wrong QR is worse
 * than no QR: it silently enrols an authenticator against the wrong secret and
 * the admin discovers it when they are locked out. Correctness wins here.
 *
 * It is bundled at build time — no external origin is contacted, so AR-09's "no
 * third-party scripts" still holds, and the rendered output is a data: URI image
 * which the CSP already permits.
 *
 * The manual-entry key is always shown alongside, so a failure to render the
 * code never blocks enrolment.
 */

import React, { useEffect, useState } from 'react';

export function QrCode({ text, size = 168 }: { text: string; size?: number }) {
    const [dataUrl, setDataUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        import('qrcode')
            .then((QRCode) =>
                QRCode.toDataURL(text, {
                    width: size,
                    margin: 1,
                    errorCorrectionLevel: 'M',
                    color: { dark: '#2c2c2c', light: '#ffffff' },
                })
            )
            .then((url) => { if (!cancelled) setDataUrl(url); })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, [text, size]);

    if (failed) {
        return (
            <div style={{
                width: size, height: size, display: 'grid', placeItems: 'center',
                fontSize: 12, color: 'var(--muted-2)', textAlign: 'center', padding: 12,
            }}>
                Could not draw the code — use the manual key below.
            </div>
        );
    }

    if (!dataUrl) {
        return <div className="skeleton" style={{ width: size, height: size }} />;
    }

    // eslint-disable-next-line @next/next/no-img-element
    return <img src={dataUrl} alt="Authenticator enrolment QR code" width={size} height={size} />;
}
