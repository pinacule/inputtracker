package dev.pinacule.inputtracker

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Insets
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.text.InputType
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import android.widget.Toolbar

/**
 * Dedicated Android shell for the self-hosted InputTracker web app.
 *
 * The app is a WebView pointed at the user's own InputTracker server
 * (default: the Oracle VM over Tailscale). The server address is stored in
 * SharedPreferences and can be changed from the toolbar menu, so moving the
 * server never requires a rebuild. Everything else — file upload for the
 * Import page, DownloadManager for the /api/export.* links, external links
 * to the browser, in-app back navigation — exists to make the PWA behave
 * like a native app.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var toolbar: Toolbar
    private lateinit var progressBar: ProgressBar
    private lateinit var errorBox: View
    private lateinit var errorText: TextView

    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val prefs by lazy { getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE) }

    private fun serverUrl(): String = prefs.getString(KEY_SERVER_URL, DEFAULT_URL) ?: DEFAULT_URL

    private fun serverHost(): String? = Uri.parse(serverUrl()).host

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        toolbar = findViewById(R.id.toolbar)
        setActionBar(toolbar)
        toolbar.title = getString(R.string.app_name)

        progressBar = findViewById(R.id.progress)
        errorBox = findViewById(R.id.errorBox)
        errorText = findViewById(R.id.errorText)
        webView = findViewById(R.id.webview)

        applyWindowInsets()
        configureWebView()

        findViewById<Button>(R.id.retryButton).setOnClickListener {
            errorBox.visibility = View.GONE
            webView.loadUrl(serverUrl())
        }
        findViewById<Button>(R.id.changeUrlButton).setOnClickListener { showServerUrlDialog() }

        if (savedInstanceState != null && webView.restoreState(savedInstanceState) != null) {
            // WebView state restored after recreation; nothing to load.
        } else {
            webView.loadUrl(serverUrl())
        }
    }

    /**
     * Keep the toolbar and content clear of the status/navigation bars —
     * and consume the insets afterwards. If they were passed on unchanged,
     * the WebView would forward them to the page as CSS
     * env(safe-area-inset-*), and the page adds env(safe-area-inset-bottom)
     * on top of its fixed bottom-nav height: the nav rendered ~48dp taller
     * than designed and page content stayed hidden behind it, because the
     * native padding here had already moved everything clear of the bars.
     * Zeroing the insets for children makes the page see the same geometry
     * as in Chrome standalone: nav exactly as tall as designed.
     */
    private fun applyWindowInsets() {
        val root = findViewById<View>(R.id.root)
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                WindowInsets.Builder(insets)
                    .setInsets(WindowInsets.Type.systemBars(), Insets.NONE)
                    .build()
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(
                    insets.systemWindowInsetLeft,
                    insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight,
                    insets.systemWindowInsetBottom
                )
                @Suppress("DEPRECATION")
                insets.consumeSystemWindowInsets()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            databaseEnabled = true
            allowContentAccess = true
            allowFileAccess = false
            mediaPlaybackRequiresUserGesture = false
            // Render exactly like Chrome does for this PWA: the page ships a
            // correct width=device-width viewport, so do NOT enable the wide
            // viewport or overview (fit-to-page) mode — both re-scale the
            // layout away from the design. Zoom is off for the same reason.
            setSupportZoom(false)
            loadWithOverviewMode = false
            useWideViewPort = false
            // Android WebView scales text by the phone's system font-size
            // setting; Chrome does not. Pin 100% so the page's typography
            // fits the screen exactly as designed.
            textZoom = 100
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString InputTrackerApp/${BuildConfig.VERSION_NAME}"
        }

        // No web-style long-press text selection (Copy/Share popup) on page
        // content — this is an app, not a browser tab. Text fields keep
        // their own editing behaviour; this only consumes the page-level
        // long click.
        webView.setOnLongClickListener { true }
        webView.isHapticFeedbackEnabled = false

        // App feel, not browser feel: no scrollbars drawn over the page and
        // no overscroll edge glow.
        webView.isVerticalScrollBarEnabled = false
        webView.isHorizontalScrollBarEnabled = false
        webView.overScrollMode = View.OVER_SCROLL_NEVER

        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(webView, false)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest
            ): Boolean {
                val uri = request.url
                val host = uri.host
                // Pages on the configured server stay in the app.
                if (host != null && host.equals(serverHost(), ignoreCase = true)) {
                    return false
                }
                return when (uri.scheme) {
                    "http", "https", "tel", "mailto", "sms", "intent" -> {
                        openExternal(uri)
                        true
                    }
                    else -> false
                }
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                progressBar.visibility = View.VISIBLE
                progressBar.progress = 0
            }

            override fun onPageFinished(view: WebView, url: String?) {
                progressBar.visibility = View.GONE
                if (url != null && !url.startsWith("about:")) {
                    errorBox.visibility = View.GONE
                }
                // Seamless taps: kill the gray tap-highlight flash and the
                // page-level rubber-band overscroll. Deliberately does not
                // touch user-select, so text fields keep native editing.
                view.evaluateJavascript(
                    "(function(){var s=document.createElement('style');" +
                        "s.textContent='*{-webkit-tap-highlight-color:transparent}" +
                        "html{overscroll-behavior:none}';" +
                        "if(document.head){document.head.appendChild(s);}})()",
                    null
                )
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) {
                    showError(
                        "Could not reach InputTracker at\n${serverUrl()}\n\n" +
                            "Check that the server is running and that Tailscale " +
                            "is connected on this phone."
                    )
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progressBar.progress = newProgress
                progressBar.visibility =
                    if (newProgress in 1..99) View.VISIBLE else View.GONE
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                return try {
                    startActivityForResult(fileChooserParams.createIntent(), REQUEST_FILE_CHOOSER)
                    true
                } catch (e: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }

        // The web app's export buttons are plain links to /api/export.json and
        // /api/export.csv; hand them to the system DownloadManager so the
        // files land in Downloads like a browser download would.
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            if (url.startsWith("blob:") || url.startsWith("data:")) {
                Toast.makeText(
                    this, "This download is not supported in the app",
                    Toast.LENGTH_LONG
                ).show()
                return@setDownloadListener
            }
            val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle(fileName)
                .setDescription("InputTracker export")
                .setMimeType(mimeType)
                .setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                )
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
            CookieManager.getInstance().getCookie(url)
                ?.let { request.addRequestHeader("Cookie", it) }
            request.addRequestHeader("User-Agent", userAgent)
            val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            try {
                manager.enqueue(request)
                Toast.makeText(this, "Downloading $fileName", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "Download failed: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun showError(message: String) {
        errorText.text = message
        errorBox.visibility = View.VISIBLE
        progressBar.visibility = View.GONE
    }

    private fun openExternal(uri: Uri) {
        try {
            if (uri.scheme == "intent") {
                startActivity(Intent.parseUri(uri.toString(), Intent.URI_INTENT_SCHEME))
            } else {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            }
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, "No app can open this link", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Could not open this link", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main_menu, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.action_reload -> {
            errorBox.visibility = View.GONE
            webView.reload()
            true
        }
        R.id.action_server_url -> {
            showServerUrlDialog()
            true
        }
        R.id.action_open_browser -> {
            openExternal(Uri.parse(serverUrl()))
            true
        }
        else -> super.onOptionsItemSelected(item)
    }

    private fun showServerUrlDialog() {
        val input = EditText(this).apply {
            setText(serverUrl())
            setSingleLine(true)
            hint = "https://your-server.example"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        val density = resources.displayMetrics.density
        val container = FrameLayout(this).apply {
            val h = (16 * density).toInt()
            setPadding(h, (8 * density).toInt(), h, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.dialog_server_title)
            .setMessage(R.string.dialog_server_message)
            .setView(container)
            .setPositiveButton(R.string.dialog_save) { _, _ ->
                val normalized = normalizeUrl(input.text.toString())
                if (normalized == null) {
                    Toast.makeText(
                        this, "That does not look like a valid URL",
                        Toast.LENGTH_LONG
                    ).show()
                } else {
                    applyServerUrl(normalized)
                }
            }
            .setNeutralButton(R.string.dialog_reset) { _, _ -> applyServerUrl(DEFAULT_URL) }
            .setNegativeButton(R.string.dialog_cancel, null)
            .show()
    }

    private fun applyServerUrl(url: String) {
        prefs.edit().putString(KEY_SERVER_URL, url).apply()
        errorBox.visibility = View.GONE
        webView.loadUrl(url)
    }

    private fun normalizeUrl(raw: String): String? {
        var candidate = raw.trim()
        if (candidate.isEmpty()) return null
        if (!candidate.contains("://")) candidate = "https://$candidate"
        val uri = Uri.parse(candidate)
        if (uri.scheme != "http" && uri.scheme != "https") return null
        if (uri.host.isNullOrEmpty()) return null
        return candidate.trimEnd('/')
    }

    @Suppress("DEPRECATION") // Framework Activity result API; this app has no AndroidX.
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_FILE_CHOOSER) return
        val callback = fileCallback ?: return
        fileCallback = null
        val clip = data?.clipData
        val results: Array<Uri>? = when {
            resultCode != RESULT_OK -> null
            clip != null -> Array(clip.itemCount) { i -> clip.getItemAt(i).uri }
            data?.data != null -> arrayOf(data.data!!)
            else -> null
        }
        callback.onReceiveValue(results)
    }

    @Suppress("DEPRECATION") // OnBackPressedDispatcher requires AndroidX; override is fine here.
    override fun onBackPressed() {
        if (errorBox.visibility != View.VISIBLE && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onDestroy() {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val PREFS_NAME = "inputtracker"
        private const val KEY_SERVER_URL = "server_url"
        private const val DEFAULT_URL = "https://input-tracker.taild61ed4.ts.net"
        private const val REQUEST_FILE_CHOOSER = 1001
    }
}
