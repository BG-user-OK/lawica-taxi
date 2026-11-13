export async function readFeed(endpoint, version, ack) {
  const url = new URL(endpoint);
  if (version) url.searchParams.set('version', version);
  if (ack) url.searchParams.set('ack', ack);
  url.searchParams.set('_', Date.now());
  try {
    const response = await fetch(url, {
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(5500)
    });
    if (response.ok) return await response.json();
  } catch {
    // ContentService may redirect to a response without CORS headers.
  }
  return new Promise((resolve, reject) => {
    const callback = `lawica_${crypto.randomUUID().replaceAll('-', '')}`;
    const script = document.createElement('script');
    const finish = (handler, value) => {
      clearTimeout(timer);
      script.remove();
      delete window[callback];
      handler(value);
    };
    const fail = () => finish(reject, new Error('Brak odpowiedzi z arkusza'));
    const timer = setTimeout(fail, 8000);
    window[callback] = value => finish(resolve, value);
    url.searchParams.set('callback', callback);
    script.src = url.href;
    script.referrerPolicy = 'no-referrer';
    script.onerror = fail;
    script.onload = () => { if (window[callback]) fail(); };
    document.head.append(script);
  });
}

export async function writeDirection(endpoint, operation, key) {
  await fetch(endpoint, {
    method: 'POST', mode: 'no-cors', credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ...operation, key }), signal: AbortSignal.timeout(12000)
  });
  // The cross-origin response may be opaque. Confirm via the next public read.
}
