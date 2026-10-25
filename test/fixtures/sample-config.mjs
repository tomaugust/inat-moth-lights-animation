// Small, hand-written config used by unit tests. Mirrors the shape of
// config/site-config.json (animation, audio, light and scene sections).
export function createSampleConfig() {
  return {
    animation: {
      autoplay: true,
      backgroundColor: "#101114",
      launchScreenEnabled: false,
      speciesTag: true,
      speciesTagColor: "",
      speciesTagDuration: 5.5,
      speciesTagSize: 13
    },
    audio: {
      chimeProbability: 0.3,
      droneBrightness: 0.45,
      droneEnabled: false,
      droneNotes: ["D2", "A2", "D3"],
      droneVariation: 0.65,
      droneVolume: 0.035,
      enabled: true,
      minInterval: 0.85,
      noteDecay: 2.8,
      volume: 0.12
    },
    light: {
      color: "#fffdf4",
      flickerSpeed: 0.0025,
      flickerStrength: 0.06,
      glowColor: "rgba(255, 250, 226, 0.8)",
      glowRadius: 150,
      haloColor: "rgba(255, 244, 201, 0.22)",
      shadowBlur: 36,
      size: 15
    },
    scene: {
      backgroundMothOpacity: 0.45,
      centerYRatio: 0.55,
      foregroundMothOpacity: 1,
      groundBackColor: "#07080b",
      groundFrontColor: "#211b14",
      groundMidColor: "#14120f",
      horizontalEdgeMothOpacity: 0.28,
      horizontalFadeEnabled: true,
      horizonYRatio: 0.34,
      lightPoolColor: "rgba(255, 244, 201, 0.3)",
      lightPoolRadius: 330,
      mothShadowBlur: 12,
      mothShadowLength: 110,
      mothShadowOpacity: 0.22,
      mothShadowsEnabled: false,
      orbitRadiusScale: 0.92,
      orbitTilt: 0.3,
      showGround: true
    }
  };
}
