import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, type StyleProp, type TextStyle } from 'react-native';
import { NUMERIC_DIRECTION } from '../lib/direction';
import { formatSigned, moved, signColor, theme } from '../lib/theme';

/**
 * A live profit-or-loss figure: blue while up, red while down, and a short
 * wash of the direction it just moved each time the server sends a new one.
 *
 * The figure is always the one given — nothing is counted up through numbers
 * the account never showed. The wash is the only motion, and it is off for
 * anyone who has asked their phone for less motion; the colour still says it.
 * `null` is an em dash: a missing price is not a zero.
 */
export function PnlText({
  value,
  style,
}: {
  value: string | null;
  style?: StyleProp<TextStyle>;
}): React.ReactElement {
  const previous = useRef(value);
  const wash = useRef(new Animated.Value(0)).current;
  const [tone, setTone] = useState<'up' | 'down'>('up');
  const [still, setStill] = useState(false);

  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (live) setStill(on);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setStill);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    const direction = moved(previous.current, value);
    previous.current = value;
    if (direction === null || still) return;
    setTone(direction);
    wash.setValue(1);
    Animated.timing(wash, { toValue: 0, duration: 700, useNativeDriver: false }).start();
  }, [value, still, wash]);

  const backgroundColor = wash.interpolate({
    inputRange: [0, 1],
    outputRange: [
      'rgba(0,0,0,0)',
      tone === 'up' ? 'rgba(56,189,248,0.30)' : 'rgba(234,57,67,0.30)',
    ],
  });

  return (
    <Animated.Text
      style={[
        style,
        {
          color: value === null ? theme.colors.textMuted : signColor(value),
          writingDirection: NUMERIC_DIRECTION,
          backgroundColor,
          borderRadius: 4,
          paddingHorizontal: 2,
        },
      ]}
    >
      {value === null ? '—' : formatSigned(value)}
    </Animated.Text>
  );
}
