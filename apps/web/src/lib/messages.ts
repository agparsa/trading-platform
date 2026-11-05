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
 * Translated so far: the section navigation, the page frame, sign-in,
 * Settings, the terminal's frame and tabs, the account strip and the order
 * ticket. The tables inside the panels and the other pages are still English
 * — `docs/uiux.md` says which, and the language switch says so too.
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
    "For this browser only. Persian covers navigation, sign-in, Settings, the terminal's frame, the account strip and the order ticket so far; tables, other pages and server messages are still in English.",
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
  'terminal.watchlist': 'Watchlist',
  'terminal.activity': 'Activity',
  'terminal.order': 'Order',
  'terminal.instrument': 'Instrument',
  'terminal.shortcuts': 'Keyboard shortcuts',
  'terminal.buildStatus': 'Build status',
  'tab.positions': 'Positions',
  'tab.pending': 'Pending',
  'tab.trades': 'Trades',
  'tab.closed': 'Closed',
  'tab.orders': 'Orders',
  'tab.alerts': 'Alerts',
  'tab.finance': 'Finance',
  'tab.logs': 'Logs',
  'account.account': 'Account',
  'account.balance': 'Balance',
  'account.equity': 'Equity',
  'account.floating': 'Floating P&L',
  'account.realizedToday': 'Realized today',
  'account.usedMargin': 'Used margin',
  'account.freeMargin': 'Free margin',
  'account.marginLevel': 'Margin level',
  'account.utilisation': 'Utilisation',
  'account.exposure': 'Exposure',
  'account.positions': 'Positions',
  'account.orders': 'Orders',
  'ticket.selectInstrument': 'Select an instrument to trade.',
  'ticket.volume': 'Volume (lots)',
  'ticket.decrease': 'Decrease volume',
  'ticket.increase': 'Increase volume',
  'ticket.stopPrice': 'Stop price',
  'ticket.limitPrice': 'Limit price',
  'ticket.valid': 'Valid',
  'ticket.gtc': 'GTC',
  'ticket.day': 'Day',
  'ticket.stopLoss': 'Stop loss',
  'ticket.takeProfit': 'Take profit',
  'ticket.trailing': 'Trailing distance',
  'ticket.refused': 'This order would be refused now:',
  'ticket.estMargin': 'Est. margin',
  'ticket.estCommission': 'Est. commission',
  'ticket.swapNight': 'Swap / night',
  'ticket.executable': 'Executable',
  'ticket.marketNow': 'Market now',
  'ticket.ifStopped': 'If stopped',
  'ticket.ifTarget': 'If target hits',
  'ticket.risk': 'Risk',
  'ticket.rewardRisk': 'Reward : risk',
  'ticket.sent': 'Sent',
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
    'فقط برای همین مرورگر. فارسی فعلاً منو، ورود، تنظیمات، قاب ترمینال، نوار حساب و فرم سفارش را پوشش می‌دهد؛ جدول‌ها، بقیهٔ صفحه‌ها و پیام‌های سرور هنوز انگلیسی هستند.',
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
  'terminal.watchlist': 'دیده‌بان',
  'terminal.activity': 'فعالیت',
  'terminal.order': 'سفارش',
  'terminal.instrument': 'نماد',
  'terminal.shortcuts': 'میان‌برهای صفحه‌کلید',
  'terminal.buildStatus': 'وضعیت نسخه',
  'tab.positions': 'پوزیشن‌ها',
  'tab.pending': 'در انتظار',
  'tab.trades': 'معاملات',
  'tab.closed': 'بسته‌شده',
  'tab.orders': 'سفارش‌ها',
  'tab.alerts': 'هشدارها',
  'tab.finance': 'مالی',
  'tab.logs': 'گزارش رویدادها',
  'account.account': 'حساب',
  'account.balance': 'موجودی',
  'account.equity': 'اکوئیتی',
  'account.floating': 'سود/زیان شناور',
  'account.realizedToday': 'تحقق‌یافتهٔ امروز',
  'account.usedMargin': 'مارجین درگیر',
  'account.freeMargin': 'مارجین آزاد',
  'account.marginLevel': 'سطح مارجین',
  'account.utilisation': 'میزان استفاده',
  'account.exposure': 'اکسپوژر',
  'account.positions': 'پوزیشن‌ها',
  'account.orders': 'سفارش‌ها',
  'ticket.selectInstrument': 'برای معامله یک نماد انتخاب کنید.',
  'ticket.volume': 'حجم (لات)',
  'ticket.decrease': 'کاهش حجم',
  'ticket.increase': 'افزایش حجم',
  'ticket.stopPrice': 'قیمت استاپ',
  'ticket.limitPrice': 'قیمت لیمیت',
  'ticket.valid': 'اعتبار',
  'ticket.gtc': 'تا لغو',
  'ticket.day': 'روزانه',
  'ticket.stopLoss': 'حد ضرر',
  'ticket.takeProfit': 'حد سود',
  'ticket.trailing': 'فاصلهٔ استاپ متحرک',
  'ticket.refused': 'این سفارش الان رد می‌شود:',
  'ticket.estMargin': 'مارجین تخمینی',
  'ticket.estCommission': 'کارمزد تخمینی',
  'ticket.swapNight': 'سواپ / شب',
  'ticket.executable': 'قیمت اجرا',
  'ticket.marketNow': 'قیمت فعلی بازار',
  'ticket.ifStopped': 'اگر حد ضرر بخورد',
  'ticket.ifTarget': 'اگر حد سود بخورد',
  'ticket.risk': 'ریسک',
  'ticket.rewardRisk': 'نسبت سود به ریسک',
  'ticket.sent': 'ارسال‌شده',
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
