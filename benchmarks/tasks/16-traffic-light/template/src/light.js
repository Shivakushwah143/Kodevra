export function createTrafficLight() {
  let state = "red";

  return {
    current: () => state,
    next: () => {
      state = state === "red" ? "yellow" : state === "yellow" ? "green" : "red";
      return state;
    },
    reset: () => {},
  };
}
