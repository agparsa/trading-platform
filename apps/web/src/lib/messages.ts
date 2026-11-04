import type { Locale } from './locale';

/**
 * The interface's words, in English and Persian.
 *
 * English is the source: its keys are the vocabulary, and the Persian table is
 * typed against them, so a key added in English and not translated fails the
 * build rather than appearing as a raw key on a Persian screen. A `{name}` in a
 * message is filled by `translate`; both languages must use the same names
 * (`messages.test.ts`).
 *
 * Translated so far: the section navigation, the page frame, sign-in and
 * Settings. The terminal's panels and the rest of the pages are still English
 * in both — `docs/uiux.md` says which, and the language switch says so too.
 */
export const en = {
  'nav.sections': 'Sections',
  'nav.terminal': 'Terminal',
  'nav.account': 'Account',
  'nav.wallet': 'Wallet',
  'nav.verification': 'Verification',
  'nav.history': 'History',
  'nav.analytics': 'Analytics',
  'nav.instruments': 'Instruments',
  'nav.security': 'Security',
  'nav.developer': 'Developer',
  'nav.settings': 'Settings',

  'shell.brand': 'Trading Platform',
  'shell.administration': 'Administration',
  'shell.signOut': 'Sign out',

  'settings.title': 'Settings',
  'settings.description':
    'One-click trading, confirmations, default order size, appearance, language and notifications.',
  'settings.language': 'Language',
  'settings.language.note':
    'For this browser only. Persian covers navigation, sign-in and this page so far; the terminal is still in English.',
  'settings.appearance': 'Appearance',
  'settings.appearance.dark': 'Dark',
  'settings.appearance.light': 'Light',
  'settings.appearance.system': 'Same as this device',
  'settings.appearance.note':
    'For this browser only. The terminal is dark by default: it is looked at for hours.',

  'login.lead.code': 'Enter the code from your authenticator app.',
  'login.lead.signIn': 'Sign in to your terminal.',
  'login.lead.register': 'Create an account.',
  'login.code': 'Authentication code',
  'login.codeHint':
    'Six digits from your authenticator app, or one of the recovery codes you saved.',
  'login.displayName': 'Display name',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.working': 'Working…',
  'login.verify': 'Verify',
  'login.signIn': 'Sign in',
  'login.createAccount': 'Create account',
  'login.startAgain': 'Start again',
  'login.toRegister': 'Need an account? Register',
  'login.toSignIn': 'Already registered? Sign in',
  'login.cookieNote': 'Your session is kept in a cookie this page cannot read.',
  'login.unreachable': 'Could not reach the API. Check that it is running.',
  'login.serverWords': 'Messages from the server are in English for now.',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

export const fa: Messages = {
  'nav.sections': 'بخش‌ها',
  'nav.terminal': 'ترمینال',
  'nav.account': 'حساب',
  'nav.wallet': 'کیف پول',
  'nav.verification': 'احراز هویت',
  'nav.history': 'تاریخچه',
  'nav.analytics': 'تحلیل عملکرد',
  'nav.instruments': 'نمادها',
  'nav.security': 'امنیت',
  'nav.developer': 'توسعه‌دهنده',
  'nav.settings': 'تنظیمات',

  'shell.brand': 'پلتفرم معاملاتی',
  'shell.administration': 'مدیریت',
  'shell.signOut': 'خروج',

  'settings.title': 'تنظیمات',
  'settings.description': 'معامله با یک کلیک، تأییدها، حجم پیش‌فرض سفارش، ظاهر، زبان و اعلان‌ها.',
  'settings.language': 'زبان',
  'settings.language.note':
    'فقط برای همین مرورگر. فارسی فعلاً منو، ورود و همین صفحه را پوشش می‌دهد؛ ترمینال هنوز انگلیسی است.',
  'settings.appearance': 'ظاهر',
  'settings.appearance.dark': 'تیره',
  'settings.appearance.light': 'روشن',
  'settings.appearance.system': 'مثل این دستگاه',
  'settings.appearance.note':
    'فقط برای همین مرورگر. ترمینال به‌طور پیش‌فرض تیره است، چون ساعت‌ها به آن نگاه می‌شود.',

  'login.lead.code': 'کد برنامهٔ احراز هویت را وارد کنید.',
  'login.lead.signIn': 'به ترمینال خود وارد شوید.',
  'login.lead.register': 'یک حساب بسازید.',
  'login.code': 'کد تأیید',
  'login.codeHint': 'شش رقم از برنامهٔ احراز هویت، یا یکی از کدهای بازیابی که ذخیره کرده‌اید.',
  'login.displayName': 'نام نمایشی',
  'login.email': 'ایمیل',
  'login.password': 'رمز عبور',
  'login.working': 'در حال انجام…',
  'login.verify': 'تأیید',
  'login.signIn': 'ورود',
  'login.createAccount': 'ساخت حساب',
  'login.startAgain': 'شروع دوباره',
  'login.toRegister': 'حساب ندارید؟ ثبت‌نام',
  'login.toSignIn': 'قبلاً ثبت‌نام کرده‌اید؟ ورود',
  'login.cookieNote': 'نشست شما در کوکی‌ای نگه داشته می‌شود که این صفحه نمی‌تواند آن را بخواند.',
  'login.unreachable': 'ارتباط با سرور برقرار نشد. مطمئن شوید در حال اجراست.',
  'login.serverWords': 'پیام‌هایی که از سرور می‌آیند فعلاً انگلیسی هستند.',
};

const TABLES: Record<Locale, Messages> = { en, fa };

/** A message in a locale, with `{name}` placeholders filled from `vars`. */
export function translate(
  locale: Locale,
  key: MessageKey,
  vars: Readonly<Record<string, string | number>> = {},
): string {
  const template = TABLES[locale][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    vars[name] === undefined ? whole : String(vars[name]),
  );
}

/** The `{name}` placeholders a message uses, for checking that translations keep them. */
export function placeholdersOf(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}
