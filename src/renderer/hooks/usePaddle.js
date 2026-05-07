import { useCallback, useEffect, useRef, useState } from 'react';
import { initializePaddle } from '@paddle/paddle-js';

const { PADDLE } = window.moodmark?.licensingConfig || {};

// Loads Paddle.js exactly once per renderer lifetime, then exposes a
// stable openCheckout() helper. The eventCallback fans Paddle events
// (checkout.completed, checkout.closed, …) out to the caller via the
// onEvent option so the caller can re-verify the license once Paddle
// reports a successful charge.
//
// Returns:
//   { paddle, ready, error, openCheckout({ priceId, email, customData }) }
export function usePaddle({ onEvent } = {}) {
  const [paddle, setPaddle] = useState(null);
  const [error, setError] = useState(null);
  const onEventRef = useRef(onEvent);

  // Keep the latest callback in a ref so we can register the
  // eventCallback once and still see fresh closures.
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let cancelled = false;
    if (!PADDLE?.clientToken || PADDLE.clientToken.startsWith('TODO_')) {
      setError(new Error('Paddle client token is not configured'));
      return undefined;
    }
    initializePaddle({
      environment: PADDLE.environment,
      token: PADDLE.clientToken,
      eventCallback: (event) => onEventRef.current?.(event),
    })
      .then((instance) => {
        if (cancelled) return;
        if (!instance) {
          setError(new Error('Paddle.initialize returned no instance'));
          return;
        }
        setPaddle(instance);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[paddle] initialize failed:', err);
        setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openCheckout = useCallback(
    ({ priceId, email, customData } = {}) => {
      if (!paddle) {
        console.warn('[paddle] openCheckout called before initialize');
        return;
      }
      if (!priceId) {
        console.warn('[paddle] openCheckout called without priceId');
        return;
      }
      paddle.Checkout.open({
        items: [{ priceId, quantity: 1 }],
        ...(email ? { customer: { email } } : {}),
        ...(customData ? { customData } : {}),
        settings: {
          displayMode: 'overlay',
          theme: 'light',
          locale: 'en',
        },
      });
    },
    [paddle],
  );

  return { paddle, ready: !!paddle, error, openCheckout, priceIds: PADDLE?.priceIds };
}
