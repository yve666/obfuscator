local function va(...)
  local args = {...}
  local n = select("#", ...)
  print("n=", n)
  for i = 1, n do
    print(i, args[i])
  end
end

va("a", "b", "c")
va(1, 2, 3, 4, 5)

local function passthru(...)
  return ...
end
print(passthru(10, 20, 30))
