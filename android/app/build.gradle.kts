// InputTracker Android wrapper (WebView shell around the self-hosted PWA).
//
// Signing is injected, never stored in the repo: the release build is signed
// only when all four environment variables are present.
//   KEYSTORE_PATH      path to the PKCS12 keystore file
//   KEYSTORE_PASSWORD  keystore password
//   KEY_ALIAS          key alias inside the keystore
//   KEY_PASSWORD       key password
// Local builds set them inline; CI sets them from the ANDROID_* repo secrets.
// Without them, assembleRelease produces an unsigned APK (fine for compile
// checks, not installable) so a missing secret can never silently ship a
// CI-debug-signed build whose signature changes on the next run.

val signingEnv = listOf("KEYSTORE_PATH", "KEYSTORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD")
    .associateWith { name -> System.getenv(name)?.takeIf { it.isNotBlank() } }
val hasSigning = signingEnv.values.all { it != null }

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.pinacule.inputtracker"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.pinacule.inputtracker"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "1.2"
    }

    signingConfigs {
        if (hasSigning) {
            create("release") {
                storeFile = file(signingEnv.getValue("KEYSTORE_PATH")!!)
                storePassword = signingEnv.getValue("KEYSTORE_PASSWORD")
                keyAlias = signingEnv.getValue("KEY_ALIAS")
                keyPassword = signingEnv.getValue("KEY_PASSWORD")
                storeType = "PKCS12"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (hasSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Deliberately empty: the wrapper uses only the Android framework
    // (WebView, DownloadManager, framework Toolbar/dialogs). No AndroidX,
    // no third-party libraries.
}
