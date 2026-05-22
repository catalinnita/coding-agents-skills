* agent: implement an agent to do TDD with input from
    1. ticket acceptance criteria
    2. actual cucumber scenarios md file
    3. code itself

* first step if the input is not a cucumber syntax scenarios is to generate an md file with scenarios in cucumber syntax
* second step is to check the cucumber scenarios and validate with the code itself that it includes all posible scenarios, even if the input is an md file with scenarios

* agent should orchestrate the actual action of reading the scenario, implement it, test it, fix it and run the test again if necessary and also the skills for:
    * creating cucumber scenarios
    * create unified mocks 
    * use the same testing methods in all tests
    * define global mocks where posible