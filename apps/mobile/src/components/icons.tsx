import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * The app's icons, drawn here as outlines on a 24-unit grid.
 *
 * Written for this app rather than taken from an icon font: a font is a
 * download and a licence for a dozen shapes, and these match the web
 * terminal's stroke weight.
 */
export type IconName =
  | 'quotes'
  | 'chart'
  | 'trade'
  | 'history'
  | 'more'
  | 'account'
  | 'bell'
  | 'user'
  | 'gear'
  | 'globe'
  | 'logout'
  | 'chevron'
  | 'wallet'
  | 'shield';

export function Icon({
  name,
  color,
  size = 22,
}: {
  name: IconName;
  color: string;
  size?: number;
}): React.ReactElement {
  const common = {
    stroke: color,
    strokeWidth: 1.7,
    fill: 'none',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      {name === 'quotes' ? (
        <>
          <Path d="M4 6h10M4 12h16M4 18h12" {...common} />
          <Path d="M18 4l2 2-2 2" {...common} />
        </>
      ) : name === 'chart' ? (
        <>
          <Path d="M4 20V4M4 20h16" {...common} />
          <Rect x="7" y="9" width="3" height="7" rx="0.5" {...common} />
          <Rect x="12.5" y="6" width="3" height="8" rx="0.5" {...common} />
          <Path d="M8.5 7v2M8.5 16v2M14 4v2M14 14v3" {...common} />
        </>
      ) : name === 'trade' ? (
        <>
          <Path d="M7 4v16M7 4l-3 3M7 4l3 3" {...common} />
          <Path d="M17 20V4M17 20l-3-3M17 20l3-3" {...common} />
        </>
      ) : name === 'history' ? (
        <>
          <Circle cx="12" cy="12" r="8.5" {...common} />
          <Path d="M12 7.5V12l3 2" {...common} />
        </>
      ) : name === 'more' ? (
        <>
          <Circle cx="5.5" cy="12" r="1.3" {...common} />
          <Circle cx="12" cy="12" r="1.3" {...common} />
          <Circle cx="18.5" cy="12" r="1.3" {...common} />
        </>
      ) : name === 'account' ? (
        <>
          <Rect x="3" y="5" width="18" height="14" rx="2.5" {...common} />
          <Path d="M3 10h18M15 14.5h3" {...common} />
        </>
      ) : name === 'wallet' ? (
        <>
          <Rect x="3" y="6" width="18" height="13" rx="2.5" {...common} />
          <Path d="M16 12.5h2M6 6l9-3 1 3" {...common} />
        </>
      ) : name === 'bell' ? (
        <>
          <Path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z" {...common} />
          <Path d="M10 20.5a2 2 0 0 0 4 0" {...common} />
        </>
      ) : name === 'user' ? (
        <>
          <Circle cx="12" cy="8.5" r="3.8" {...common} />
          <Path d="M4.5 20c1.2-3.8 4-5.5 7.5-5.5s6.3 1.7 7.5 5.5" {...common} />
        </>
      ) : name === 'shield' ? (
        <>
          <Path d="M12 21s7.5-3.6 7.5-10V5.5L12 3 4.5 5.5V11c0 6.4 7.5 10 7.5 10z" {...common} />
          <Path d="M9 12l2 2 4-4" {...common} />
        </>
      ) : name === 'gear' ? (
        <>
          <Circle cx="12" cy="12" r="3" {...common} />
          <Path
            d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"
            {...common}
          />
        </>
      ) : name === 'globe' ? (
        <>
          <Circle cx="12" cy="12" r="8.5" {...common} />
          <Path
            d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"
            {...common}
          />
        </>
      ) : name === 'logout' ? (
        <>
          <Path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14" {...common} />
          <Path d="M10 12h10M17 9l3 3-3 3" {...common} />
        </>
      ) : (
        <Path d="M9 6l6 6-6 6" {...common} />
      )}
    </Svg>
  );
}
