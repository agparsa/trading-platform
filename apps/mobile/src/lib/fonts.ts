/**
 * The app's two faces, bundled with it so they work offline from the first
 * launch: Vazirmatn for words — one family that sets Persian and Latin alike,
 * so the two languages read as one design — and JetBrains Mono for figures,
 * whose tabular digits keep a ticking price from shuffling sideways.
 *
 * Only the weights the screens use are bundled; each file is required on its
 * own so the other weights stay out of the APK.
 */
export const FONT_FILES = {
  Vazirmatn_400Regular:
    require('@expo-google-fonts/vazirmatn/400Regular/Vazirmatn_400Regular.ttf') as number,
  Vazirmatn_500Medium:
    require('@expo-google-fonts/vazirmatn/500Medium/Vazirmatn_500Medium.ttf') as number,
  Vazirmatn_600SemiBold:
    require('@expo-google-fonts/vazirmatn/600SemiBold/Vazirmatn_600SemiBold.ttf') as number,
  Vazirmatn_700Bold:
    require('@expo-google-fonts/vazirmatn/700Bold/Vazirmatn_700Bold.ttf') as number,
  Vazirmatn_800ExtraBold:
    require('@expo-google-fonts/vazirmatn/800ExtraBold/Vazirmatn_800ExtraBold.ttf') as number,
  JetBrainsMono_500Medium:
    require('@expo-google-fonts/jetbrains-mono/500Medium/JetBrainsMono_500Medium.ttf') as number,
  JetBrainsMono_700Bold:
    require('@expo-google-fonts/jetbrains-mono/700Bold/JetBrainsMono_700Bold.ttf') as number,
  JetBrainsMono_800ExtraBold:
    require('@expo-google-fonts/jetbrains-mono/800ExtraBold/JetBrainsMono_800ExtraBold.ttf') as number,
} as const;
