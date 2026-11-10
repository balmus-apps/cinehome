import com.android.build.api.variant.ApplicationAndroidComponentsExtension

plugins {
    id("com.android.application")
}

android {
    namespace = "ro.balmus.cinehome"
    compileSdk = 37

    defaultConfig {
        applicationId = "ro.balmus.cinehome"
        minSdk = 26
        // 35, not 37: from API 36, Android ignores the orientation lock on tablets (600dp and wider).
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            // Shrunk with R8 and signed with the debug key, like Ora de Joacă, so it installs over a debug build.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    lint {
        disable += setOf("OldTargetApi", "AndroidGradlePluginVersion", "GradleDependency", "NewerVersionAvailable", "SetJavaScriptEnabled")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.activity:activity:1.13.0")
    implementation("androidx.core:core:1.19.1")
}

// The server finder is the same page the LG TV app uses: copy it from ../webosapp/app into the
// APK's assets at build time, with this app's own config.js.
abstract class LauncherAssetsTask : DefaultTask() {
    @get:InputDirectory
    abstract val webosApp: DirectoryProperty

    @get:InputFile
    abstract val config: RegularFileProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val out = outputDir.get().asFile.resolve("launcher")
        out.deleteRecursively()
        out.mkdirs()
        for (name in listOf("index.html", "launcher.js", "launcher.css", "largeIcon.png")) {
            webosApp.get().asFile.resolve(name).copyTo(out.resolve(name), overwrite = true)
        }
        config.get().asFile.copyTo(out.resolve("config.js"), overwrite = true)
    }
}

val launcherAssets = tasks.register<LauncherAssetsTask>("launcherAssets") {
    webosApp.set(rootProject.layout.projectDirectory.dir("../webosapp/app"))
    config.set(layout.projectDirectory.file("launcher-config.js"))
}

extensions.getByType<ApplicationAndroidComponentsExtension>().onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(launcherAssets, LauncherAssetsTask::outputDir)
}
