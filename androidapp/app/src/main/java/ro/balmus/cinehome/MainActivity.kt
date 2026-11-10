package ro.balmus.cinehome

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * CineHome for tablets: a full-screen WebView. It starts on the bundled launcher page, which finds
 * the CineHome server on the Wi-Fi and then opens the server's own interface.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this).apply {
            setBackgroundColor(Color.rgb(11, 11, 16))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // The player starts by itself after a title is chosen
            settings.mediaPlaybackRequiresUserGesture = false
            // The launcher page is a bundled asset; it is laid out for 1920 px and scaled to fit
            settings.allowFileAccess = true
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            addJavascriptInterface(Bridge(), "CineHomeAndroid")
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                // Server gone (Mac asleep, Wi-Fi changed): back to the launcher, which retries or asks
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame && request.url.scheme != "file") view.loadUrl(LAUNCHER_URL)
                }
            }
        }
        setContentView(web)
        hideSystemBars()

        // Back goes through the page (one page back, closing menus, leaving the player);
        // the page calls CineHomeAndroid.exit() when there is nowhere left to go
        onBackPressedDispatcher.addCallback(this) {
            if (web.url.orEmpty().startsWith("file:")) finish()
            else web.evaluateJavascript(BACK_KEY_JS, null)
        }

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(LAUNCHER_URL)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        hideSystemBars()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    /** What the page can ask of the app (window.CineHomeAndroid). Called on a WebView thread. */
    inner class Bridge {
        @JavascriptInterface
        fun exit() = runOnUiThread { finish() }

        @JavascriptInterface
        fun keepScreenOn(on: Boolean) = runOnUiThread {
            if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private companion object {
        const val LAUNCHER_URL = "file:///android_asset/launcher/index.html"
        const val BACK_KEY_JS = "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'GoBack', bubbles: true }))"
    }
}
