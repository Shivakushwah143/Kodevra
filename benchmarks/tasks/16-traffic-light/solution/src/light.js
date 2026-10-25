const ORDER = ["red", "green", "yellow"];

export function createTrafficLight() {
  let state = "red";

  return {
    current: () => state,
    next: () => {
      state = ORDER[(ORDER.indexOf(state) + 1) % ORDER.length];
      return state;
    },
    reset: () => {
      state = "red";
      return state;
    },
  };
}
