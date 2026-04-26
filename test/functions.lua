local function add(a, b)
  return a + b
end
print(add(3, 4))

local function makeCounter()
  local n = 0
  return function()
    n = n + 1
    return n
  end
end

local c = makeCounter()
print(c(), c(), c())

local function fact(n)
  if n <= 1 then return 1 end
  return n * fact(n - 1)
end
print(fact(5))

local function mr() return 1, 2, 3 end
local a, b, c = mr()
print(a, b, c)
print(mr())
