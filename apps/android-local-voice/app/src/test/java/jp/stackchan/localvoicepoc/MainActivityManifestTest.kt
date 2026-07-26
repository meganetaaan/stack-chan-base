package jp.stackchan.localvoicepoc

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MainActivityManifestTest {
    @Test
    fun usbAttachReusesTheSingleMainActivityInstance() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val mainActivity = Regex(
            """<activity\s+[^>]*android:name="\.MainActivity"[^>]*>""",
            setOf(RegexOption.DOT_MATCHES_ALL),
        ).find(manifest)?.value.orEmpty()

        assertTrue("MainActivity must declare singleTask launch mode", mainActivity.contains("android:launchMode=\"singleTask\""))
    }
}
