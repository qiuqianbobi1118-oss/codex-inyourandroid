package com.codexrelay.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
  private lateinit var webView: WebView

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_main)

    webView = findViewById(R.id.webView)

    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      cacheMode = WebSettings.LOAD_NO_CACHE
      mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
      builtInZoomControls = false
      displayZoomControls = false
      useWideViewPort = true
      loadWithOverviewMode = true
    }
    webView.clearCache(true)

    webView.webChromeClient = WebChromeClient()
    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = false

      override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) = Unit

      override fun onPageFinished(view: WebView?, url: String?) = Unit
    }

    if (savedInstanceState == null) {
      ensureTokenAndLoad()
    } else {
      webView.restoreState(savedInstanceState)
    }
  }

  private fun ensureTokenAndLoad(forcePrompt: Boolean = false) {
    val prefs = getSharedPreferences("codex-relay", Context.MODE_PRIVATE)
    val token = prefs.getString("access_token", null)

    if (!forcePrompt && !token.isNullOrBlank()) {
      webView.loadUrl(
        "${BuildConfig.RELAY_BASE_URL}?source=android&app_version=${BuildConfig.WEB_APP_VERSION}&access_token=$token"
      )
      return
    }

    val input = EditText(this).apply {
      hint = getString(R.string.token_hint)
      setText(token.orEmpty())
    }

    AlertDialog.Builder(this)
      .setTitle(R.string.token_title)
      .setMessage(R.string.token_message)
      .setView(input)
      .setCancelable(false)
      .setPositiveButton(R.string.confirm) { _, _ ->
        val newToken = input.text?.toString()?.trim().orEmpty()
        prefs.edit().putString("access_token", newToken).apply()
        webView.loadUrl(
          "${BuildConfig.RELAY_BASE_URL}?source=android&app_version=${BuildConfig.WEB_APP_VERSION}&access_token=$newToken"
        )
      }
      .setNegativeButton(R.string.cancel, null)
      .show()
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    webView.saveState(outState)
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
    if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
      webView.goBack()
      return true
    }
    return super.onKeyDown(keyCode, event)
  }
}
