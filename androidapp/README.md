# CineHome for Android TV and tablets (planned)

A native client for the CineHome server in `../webapp`. It uses the same API as the web app (see the main README).

Planned stack:
- Kotlin + Jetpack Compose (`androidx.tv` components for the TV layout)
- Media3 / ExoPlayer for playback. It plays MKV, HEVC, AC3 and DTS natively, so it calls `/api/play/:id?client=android` and gets direct file URLs, without the server converting anything.
- Server address entered once, or found on the local network
- The same two profiles (Adults / Kids), remembered per device
