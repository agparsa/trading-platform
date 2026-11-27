import React from 'react';
import { Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { theme } from '../lib/theme';

/**
 * gotrade.io's mark: a G drawn as one stroke, with a rising arrow leaving it
 * at the top right — trading, and going up. The same drawing as the launcher
 * icon (`assets/images/logo.svg`), so the app and its icon agree.
 */
export function Logo({ size = 72 }: { size?: number }): React.ReactElement {
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024" accessibilityLabel="gotrade.io">
      <Defs>
        <LinearGradient id="logoBg" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#0B1638" />
          <Stop offset="0.55" stopColor="#1739A8" />
          <Stop offset="1" stopColor="#2F6BFF" />
        </LinearGradient>
        <LinearGradient id="logoArrow" x1="0" y1="1" x2="1" y2="0">
          <Stop offset="0" stopColor="#22D3EE" />
          <Stop offset="1" stopColor="#7DF9C3" />
        </LinearGradient>
      </Defs>
      <Rect width={1024} height={1024} rx={232} fill="url(#logoBg)" />
      <Path
        d="M676 348 A240 240 0 1 0 752 512 L560 512"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={108}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M600 600 L812 300"
        fill="none"
        stroke="url(#logoArrow)"
        strokeWidth={72}
        strokeLinecap="round"
      />
      <Path
        d="M700 268 L842 258 L832 400 Z"
        fill="#7DF9C3"
        stroke="#7DF9C3"
        strokeWidth={28}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * The name as a wordmark: the domain's suffix in the arrow's colour, so
 * "gotrade.io" reads as one mark. Any other name — a firm's own, from its
 * branding — is set plainly.
 */
export function Wordmark({ name, size = 28 }: { name: string; size?: number }): React.ReactElement {
  const dot = name.lastIndexOf('.');
  const suffix = dot > 0 ? name.slice(dot) : '';
  const base = dot > 0 ? name.slice(0, dot) : name;
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'baseline' }}
      accessible
      accessibilityLabel={name}
    >
      <Text style={{ fontFamily: theme.font.heavy, color: theme.colors.text, fontSize: size }}>
        {base}
      </Text>
      {suffix === '' ? null : (
        <Text style={{ fontFamily: theme.font.heavy, color: '#5EEAD4', fontSize: size }}>
          {suffix}
        </Text>
      )}
    </View>
  );
}
