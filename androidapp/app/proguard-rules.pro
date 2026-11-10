# The page calls these through window.CineHomeAndroid; R8 must keep them by name.
-keepclassmembers class ro.balmus.cinehome.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
