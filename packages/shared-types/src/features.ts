/**
 * Feature flags (§95): what a deployment, or a firm, has switched on.
 *
 * ## Two kinds of authority
 *
 * A flag is set either by the **platform** for a firm — a capability the
 * platform provides and turns on per customer, such as executing at an
 * external venue — or by the **firm** for itself — a product choice, such as
 * whether its traders may trail a stop. A firm cannot flip a platform flag,
 * and the platform does not manage a firm's product choices for it.
 *
 * ## Two kinds of enforcement
 *
 * `SERVER`: the API refuses the action when the flag is off, whatever the
 * client says. `CLIENT`: the flag describes a rendering or product choice the
 * server has no action to guard — which chart to draw, whether the terminal
 * offers one-click orders — and the client honours it. The distinction is
 * stated on each flag so nobody mistakes a client flag for a control.
 */

export const FeatureAuthority = { PLATFORM: 'PLATFORM', FIRM: 'FIRM' } as const;
export type FeatureAuthority = (typeof FeatureAuthority)[keyof typeof FeatureAuthority];

export const FeatureEnforcement = { SERVER: 'SERVER', CLIENT: 'CLIENT' } as const;
export type FeatureEnforcement = (typeof FeatureEnforcement)[keyof typeof FeatureEnforcement];

export const Feature = {
  EXTERNAL_EXECUTION: 'external_execution',
  WEBHOOKS: 'webhooks',
  TRAILING_STOP: 'trailing_stop',
  QUICK_TRADING: 'quick_trading',
  MOBILE_TRADING: 'mobile_trading',
  NEW_CHART: 'new_chart',
  WHITE_LABEL: 'white_label',
} as const;
export type Feature = (typeof Feature)[keyof typeof Feature];

export interface FeatureDefinition {
  readonly key: Feature;
  readonly name: string;
  readonly description: string;
  readonly authority: FeatureAuthority;
  readonly enforcement: FeatureEnforcement;
  readonly default: boolean;
  /**
   * Whether anything actually acts on this flag today.
   *
   * Structure rather than prose, because the check that keeps this honest has
   * to be mechanical. `mobile_trading` carried CLIENT enforcement — which this
   * file defines as *the client honours it* — and `feature-flags.md` named the
   * mobile app in its "Where" column. Nothing in `apps/mobile` read
   * `GET /features` at all, so an operator could switch it off, watch the
   * switch move, and change nothing.
   *
   * `false` is allowed and is not a defect: a flag for a feature that is not
   * built yet is how the gate gets designed in before the thing it gates
   * exists. What is a defect is `false` that nobody has written down.
   */
  readonly honoured: boolean;
}

export const FEATURES: readonly FeatureDefinition[] = [
  {
    key: Feature.EXTERNAL_EXECUTION,
    name: 'External execution',
    description:
      'Orders on accounts routed to an external venue are sent there. Off, they are refused rather than quietly executed internally.',
    authority: 'PLATFORM',
    enforcement: 'SERVER',
    default: false,
    honoured: true,
  },
  {
    key: Feature.WEBHOOKS,
    name: 'Webhooks',
    description: 'The firm may register endpoints and have its events delivered to them.',
    authority: 'PLATFORM',
    enforcement: 'SERVER',
    default: true,
    honoured: true,
  },
  {
    key: Feature.TRAILING_STOP,
    name: 'Trailing stops',
    description: 'Traders may set a trailing stop distance on a position. Off, a request that sets one is refused; existing trails keep ratcheting.',
    authority: 'FIRM',
    enforcement: 'SERVER',
    default: true,
    honoured: true,
  },
  {
    key: Feature.QUICK_TRADING,
    name: 'One-click trading',
    description: 'The terminal offers one-click orders. Off, every order is confirmed. A product choice the client honours; the server has no action to guard.',
    authority: 'FIRM',
    enforcement: 'CLIENT',
    default: true,
    honoured: true,
  },
  {
    key: Feature.MOBILE_TRADING,
    name: 'Mobile trading',
    description: 'The mobile app offers order entry. Off, it shows positions and alerts only. Honoured by the app; the same person can still trade from the web.',
    authority: 'FIRM',
    enforcement: 'CLIENT',
    default: true,
    honoured: true,
  },
  {
    key: Feature.NEW_CHART,
    name: 'Licensed chart',
    description: 'The terminal draws the licensed chart library instead of the built-in one. Meaningless until the licence exists.',
    authority: 'PLATFORM',
    enforcement: 'CLIENT',
    default: false,
    honoured: false,
  },
  {
    key: Feature.WHITE_LABEL,
    name: 'White label',
    description: 'The firm’s own name and branding replace the platform’s. Branding itself is not built; this flag exists so the day it is, nothing has to be redesigned to gate it.',
    authority: 'PLATFORM',
    enforcement: 'CLIENT',
    default: false,
    honoured: false,
  },
];

export const FEATURE_BY_KEY: Readonly<Record<Feature, FeatureDefinition>> = Object.fromEntries(
  FEATURES.map((definition) => [definition.key, definition]),
) as Record<Feature, FeatureDefinition>;

export function isFeature(value: string): value is Feature {
  return Object.values(Feature).includes(value as Feature);
}
