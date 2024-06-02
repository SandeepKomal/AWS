
# Attaching an IAM Role to Single / Multiple IAM User? Users in AWS

##### Let's take a scenario where Naveen, a user with full admin-level access to an AWS account, needs to attach an IAM role to an existing IAM user, Komal, who currently has no access to resources.


## Step-by-Step Instructions:

### Step 1: Create an IAM Role
##### Sign in to the AWS Management Console as Naveen.
##### Navigate to the IAM service.
##### In the left navigation pane, choose Roles and then Create role.
##### Select AWS Service and choose the service that will use this role (e.g., EC2, Lambda), or select Another AWS account if you need to allow cross-account access.
##### Select the use case for your role, and then choose Next: Permissions.
##### Attach policies that define the permissions for this role. Choose the necessary policy or create a custom one if required.
##### Choose Next: Tags to add tags (optional) and then Next: Review.
##### Enter a Role name and description, and then choose Create role.


### Step 2: Modify Trust Relationship for the Role
##### Go to the newly created role and select it.
##### Under the Trust relationships tab, choose Edit trust relationship.
##### Update the trust relationship to allow the IAM user komal to assume this role. It will look something like this:

```
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::ACCOUNT_ID:user/komal"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}

```

Then, you can run the script using:

```bash
./install_docker.sh
```

## Create Sonarqube Docker container
To run SonarQube in a Docker container with the provided command, you can follow these steps:

1. Open your terminal or command prompt.

2. Run the following command:

```bash
docker run -d --name sonar -p 9000:9000 sonarqube:lts-community
```

This command will download the `sonarqube:lts-community` Docker image from Docker Hub if it's not already available locally. Then, it will create a container named "sonar" from this image, running it in detached mode (`-d` flag) and mapping port 9000 on the host machine to port 9000 in the container (`-p 9000:9000` flag).

3. Access SonarQube by opening a web browser and navigating to `http://VmIP:9000`.

This will start the SonarQube server, and you should be able to access it using the provided URL. If you're running Docker on a remote server or a different port, replace `localhost` with the appropriate hostname or IP address and adjust the port accordingly.
