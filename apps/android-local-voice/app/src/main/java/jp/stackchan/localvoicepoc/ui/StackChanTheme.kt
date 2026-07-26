package jp.stackchan.localvoicepoc.ui

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

private val LightColors = lightColorScheme(
    primary = Color(0xFF0F766E),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFC8F0EB),
    onPrimaryContainer = Color(0xFF082F2B),
    secondary = Color(0xFFC6533F),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFDBD2),
    onSecondaryContainer = Color(0xFF45150D),
    background = Color(0xFFF7F9F8),
    onBackground = Color(0xFF18201F),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF18201F),
    surfaceVariant = Color(0xFFE3E9E7),
    onSurfaceVariant = Color(0xFF414947),
    outline = Color(0xFF707976),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF72D8CC),
    onPrimary = Color(0xFF003733),
    primaryContainer = Color(0xFF005049),
    onPrimaryContainer = Color(0xFFA0F2E8),
    secondary = Color(0xFFFFB4A3),
    onSecondary = Color(0xFF70200F),
    secondaryContainer = Color(0xFF913522),
    onSecondaryContainer = Color(0xFFFFDBD2),
    background = Color(0xFF101414),
    onBackground = Color(0xFFE0E4E2),
    surface = Color(0xFF171C1B),
    onSurface = Color(0xFFE0E4E2),
    surfaceVariant = Color(0xFF3F4946),
    onSurfaceVariant = Color(0xFFBFC9C6),
    outline = Color(0xFF89938F),
)

private val StackChanShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(6.dp),
    medium = RoundedCornerShape(8.dp),
    large = RoundedCornerShape(8.dp),
    extraLarge = RoundedCornerShape(8.dp),
)

@Composable
fun StackChanTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1
            }
        }
    }
    MaterialTheme(
        colorScheme = colors,
        shapes = StackChanShapes,
        content = content,
    )
}
