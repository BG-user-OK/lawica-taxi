export async function readFeed(endpoint, version) {
  const url = new URL(endpoint);
  if (version) url.searchParams.set('version', version);
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
